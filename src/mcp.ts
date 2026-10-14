// MCP over Streamable HTTP, stateless, serving both protocol eras on one
// endpoint — wire-compatible with the TypeScript SDK's
// `createMcpHandler(factory, { legacy: 'stateless' })`:
//
// - Legacy (2025-era): classic JSON-RPC with an `initialize` handshake, no
//   sessions. Requests are answered as a single-shot SSE stream when the
//   client accepts `text/event-stream` (the SDK's behaviour), else plain JSON.
//   Notifications/responses get 202. Batches are allowed.
// - Modern (2026-07-28): no handshake; every request carries an envelope in
//   `params._meta` plus `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name`
//   headers. `server/discover` replaces `initialize`. Results carry
//   `resultType` and `_meta["io.modelcontextprotocol/serverInfo"]`.
//
// Era classification is body-first: a request whose `params._meta` holds a
// protocol-version claim is modern; otherwise legacy (unless the header names
// a modern revision, which then requires the envelope).

import type { Session } from "./session.ts";
import { type Obj, isObj } from "./util.ts";

export const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_BATCH = 100;

const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const META_LOG_LEVEL = "io.modelcontextprotocol/logLevel";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

export interface ServerInfo {
  name: string;
  version: string;
  instructions: string;
}

/** Transport-neutral HTTP request; `header` looks names up case-insensitively. */
export interface HttpRequest {
  method: string;
  header(name: string): string | undefined;
  body: string;
}

export interface HttpResponse {
  status: number;
  contentType?: string;
  body: string;
}

function jsonResp(status: number, body: unknown): HttpResponse {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

const accepted = (): HttpResponse => ({ status: 202, body: "" });

function sse(messages: unknown[]): HttpResponse {
  const body = messages.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join("");
  return { status: 200, contentType: "text/event-stream", body };
}

export function capabilities(): Obj {
  // listChanged is false: the tool surface is static per deployment, and
  // advertising it would make modern clients open subscriptions/listen.
  return { tools: { listChanged: false } };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Obj {
  const error: Obj = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", error, id };
}

function rpcResult(id: unknown, result: unknown): Obj {
  return { jsonrpc: "2.0", id, result };
}

/** Echo a request id when it is a string or number, else null. */
function echoId(m: Obj): unknown {
  return typeof m.id === "string" || typeof m.id === "number" ? m.id : null;
}

const isRequest = (m: Obj) => typeof m.method === "string" && (typeof m.id === "string" || typeof m.id === "number");
const isNotification = (m: Obj) => typeof m.method === "string" && !("id" in m);
const isResponse = (m: Obj) => !("method" in m) && "id" in m && ("result" in m || "error" in m);
const isMessage = (m: unknown): m is Obj =>
  isObj(m) && m.jsonrpc === "2.0" && (isRequest(m) || isNotification(m) || isResponse(m));

function claim(m: Obj): unknown {
  const meta = m.params?._meta;
  return isObj(meta) ? meta[META_PROTOCOL_VERSION] : undefined;
}

const isModernVersion = (v: string) => v >= MODERN_VERSION;

const mediaType = (ct: string) => (ct.split(";")[0] ?? "").trim().toLowerCase();

function bodyTooLarge(body: string): boolean {
  return body.length > MAX_BODY_BYTES / 3 && new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES;
}

/** Handle one POST/GET/... to the MCP endpoint. */
export async function handle(info: ServerInfo, ctx: Session, req: HttpRequest): Promise<HttpResponse> {
  if (req.method !== "POST") return jsonResp(405, rpcError(null, -32000, "Method not allowed."));
  if (mediaType(req.header("content-type") ?? "") !== "application/json") {
    return jsonResp(415, rpcError(null, -32000, "Unsupported Media Type: Content-Type must be application/json"));
  }
  if (bodyTooLarge(req.body)) {
    return jsonResp(413, rpcError(null, -32000, `Payload Too Large: Request body must not exceed ${MAX_BODY_BYTES} bytes`));
  }
  let body: unknown;
  try {
    body = JSON.parse(req.body);
  } catch {
    return jsonResp(400, rpcError(null, -32700, "Parse error: Invalid JSON"));
  }
  const headerVersion = req.header("mcp-protocol-version") || undefined;
  const headerModern = headerVersion !== undefined && isModernVersion(headerVersion);

  if (Array.isArray(body)) {
    if (!body.length) return jsonResp(400, rpcError(null, -32600, "Bad Request: empty JSON-RPC batch"));
    if (body.some((m) => isObj(m) && claim(m) !== undefined)) {
      return jsonResp(
        400,
        rpcError(null, -32600, "Bad Request: JSON-RPC batches may not contain requests for protocol revision 2026-07-28 or later"),
      );
    }
    if (!body.every(isMessage)) {
      return jsonResp(400, rpcError(null, -32600, "Bad Request: JSON-RPC batch contains an invalid message"));
    }
    return legacy(info, ctx, req, body);
  }
  if (!isObj(body)) {
    return jsonResp(400, rpcError(null, -32600, "Bad Request: the request body is not a valid JSON-RPC message"));
  }
  const m = body;
  if (isResponse(m)) return legacy(info, ctx, req, [m]);
  if (isRequest(m)) {
    const method: string = m.method;
    const c = claim(m);
    if (c === undefined && method === "initialize") {
      if (headerModern) return headerMismatch(m, "MCP-Protocol-Version", headerVersion, "initialize");
      return legacy(info, ctx, req, [m]);
    }
    if (c !== undefined) {
      const invalid = validateEnvelope(m);
      if (invalid) return invalid;
      const claimed = c as string;
      if (headerVersion !== undefined && headerVersion !== claimed) {
        return headerMismatch(m, "MCP-Protocol-Version", headerVersion, claimed);
      }
      const h = req.header("mcp-method");
      if (h !== undefined && h !== method) return headerMismatch(m, "Mcp-Method", h, method);
      return modern(info, ctx, req, m);
    }
    if (headerModern) {
      return jsonResp(
        400,
        rpcError(
          echoId(m),
          -32602,
          `Invalid params: the MCP-Protocol-Version header names protocol revision ${headerVersion}, but the request is missing the required per-request envelope key(s): ${META_PROTOCOL_VERSION}, ${META_CLIENT_CAPABILITIES}`,
          { envelope: { missing: [META_PROTOCOL_VERSION, META_CLIENT_CAPABILITIES] } },
        ),
      );
    }
    return legacy(info, ctx, req, [m]);
  }
  if (isNotification(m)) {
    const c = claim(m);
    if (c !== undefined) {
      if (typeof c !== "string") {
        return jsonResp(400, rpcError(null, -32602, "Invalid params: protocol version claim must be a string"));
      }
      if (headerVersion !== undefined && headerVersion !== c) return headerMismatch(m, "MCP-Protocol-Version", headerVersion, c);
      return accepted();
    }
    if (headerModern) return accepted();
    return legacy(info, ctx, req, [m]);
  }
  return jsonResp(400, rpcError(null, -32600, "Bad Request: the request body is not a valid JSON-RPC message"));
}

function headerMismatch(m: Obj, header: string, got: string, body: string): HttpResponse {
  return jsonResp(
    400,
    rpcError(
      echoId(m),
      -32020,
      `Bad Request: the request headers and body disagree: ${header} header is "${got}" but the body says "${body}"`,
      { mismatch: { header: got, body } },
    ),
  );
}

/**
 * Modern envelope: protocolVersion (string) and clientCapabilities (object)
 * are required; clientInfo / logLevel are optional but typed.
 */
function validateEnvelope(m: Obj): HttpResponse | undefined {
  const meta: Obj = m.params._meta;
  const problems: string[] = [];
  if (typeof meta[META_PROTOCOL_VERSION] !== "string") problems.push(`${META_PROTOCOL_VERSION} must be a string`);
  if (!isObj(meta[META_CLIENT_CAPABILITIES])) problems.push(`${META_CLIENT_CAPABILITIES} must be an object`);
  if (META_CLIENT_INFO in meta && !isObj(meta[META_CLIENT_INFO])) problems.push(`${META_CLIENT_INFO} must be an object`);
  if (META_LOG_LEVEL in meta) {
    const levels = ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"];
    if (!levels.includes(meta[META_LOG_LEVEL])) problems.push(`${META_LOG_LEVEL} is not a valid log level`);
  }
  if (!problems.length) return undefined;
  return jsonResp(400, rpcError(echoId(m), -32602, `Invalid params: ${problems.join("; ")}`));
}

// ---------------------------------------------------------------------------
// Legacy era
// ---------------------------------------------------------------------------

async function legacy(info: ServerInfo, ctx: Session, req: HttpRequest, messages: unknown[]): Promise<HttpResponse> {
  if (messages.length > MAX_BATCH) {
    return jsonResp(400, rpcError(null, -32600, "Invalid Request: Batch must not exceed 100 messages"));
  }
  if (!messages.every(isMessage)) return jsonResp(400, rpcError(null, -32700, "Parse error: Invalid JSON-RPC message"));
  const hasInit = messages.some((m) => m.method === "initialize");
  if (hasInit && messages.length > 1) {
    return jsonResp(400, rpcError(null, -32600, "Invalid Request: Only one initialization request is allowed"));
  }
  if (!hasInit) {
    const v = req.header("mcp-protocol-version");
    if (v && !LEGACY_VERSIONS.includes(v)) {
      return jsonResp(
        400,
        rpcError(null, -32000, `Bad Request: Unsupported protocol version: ${v} (supported versions: ${LEGACY_VERSIONS.join(", ")})`),
      );
    }
  }

  const requests = messages.filter(isRequest);
  if (!requests.length) return accepted();
  const responses: Obj[] = [];
  for (const m of requests) {
    const params: Obj = m.params ?? {};
    let res: RpcResult;
    if (m.method === "initialize") {
      const requested = params.protocolVersion;
      const result: Obj = {
        protocolVersion: LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0],
        capabilities: capabilities(),
        serverInfo: { name: info.name, version: info.version },
      };
      if (info.instructions) result.instructions = info.instructions;
      res = { ok: result };
    } else if (m.method === "ping") {
      res = { ok: {} };
    } else {
      res = await dispatch(ctx, m.method, params);
    }
    responses.push("ok" in res ? rpcResult(m.id, res.ok) : rpcError(m.id, res.code, res.message, res.data));
  }

  if (req.header("accept")?.includes("text/event-stream")) return sse(responses);
  return jsonResp(200, messages.length === 1 ? responses[0] : responses);
}

// ---------------------------------------------------------------------------
// Modern era
// ---------------------------------------------------------------------------

async function modern(info: ServerInfo, ctx: Session, req: HttpRequest, m: Obj): Promise<HttpResponse> {
  const id = echoId(m);
  const method: string = m.method;
  const claimed = claim(m) as string;
  if (claimed !== MODERN_VERSION) {
    return jsonResp(
      400,
      rpcError(id, -32022, `Unsupported protocol version: ${claimed}`, { supported: [MODERN_VERSION], requested: claimed }),
    );
  }

  // Standard request headers.
  if (req.header("mcp-protocol-version") === undefined) return missingHeader(id, "MCP-Protocol-Version");
  if (req.header("mcp-method") === undefined) return missingHeader(id, "Mcp-Method");
  const nameParam =
    method === "tools/call" || method === "prompts/get" ? m.params.name : method === "resources/read" ? m.params.uri : undefined;
  if (method === "tools/call" || method === "prompts/get" || method === "resources/read") {
    const expected = typeof nameParam === "string" ? nameParam : "";
    const raw = req.header("mcp-name");
    if (raw === undefined) return missingHeader(id, "Mcp-Name");
    const got = decodeParamValue(raw);
    if (got === undefined) return headerMismatch(m, "Mcp-Name", raw, expected);
    if (got !== expected) return headerMismatch(m, "Mcp-Name", got, expected);
  }

  const params: Obj = m.params ?? {};
  let res: RpcResult;
  if (method === "server/discover") {
    const r: Obj = { supportedVersions: [MODERN_VERSION], capabilities: capabilities() };
    if (info.instructions) r.instructions = info.instructions;
    res = { ok: r };
  } else if (["initialize", "ping", "subscriptions/listen", "logging/setLevel"].includes(method)) {
    // Removed in the modern era, and anything we don't serve.
    res = { code: -32601, message: "Method not found" };
  } else {
    res = await dispatch(ctx, method, params);
  }
  if ("ok" in res) {
    const r: Obj = res.ok;
    r.resultType = "complete";
    if (method !== "tools/call") {
      r.ttlMs = 0;
      r.cacheScope = "private";
    }
    r._meta = { [META_SERVER_INFO]: { name: info.name, version: info.version } };
    return jsonResp(200, rpcResult(id, r));
  }
  return jsonResp(res.code === -32601 ? 404 : 200, rpcError(id, res.code, res.message, res.data));
}

function missingHeader(id: unknown, header: string): HttpResponse {
  return jsonResp(
    400,
    rpcError(id, -32020, `Bad Request: the request headers and body disagree: required header ${header} is missing`, {
      mismatch: { header, body: null },
    }),
  );
}

/**
 * Header values outside printable ASCII arrive as `=?base64?<b64>?=`.
 * Returns undefined when that encoding is malformed.
 */
function decodeParamValue(raw: string): string | undefined {
  if (!raw.startsWith("=?base64?") || !raw.endsWith("?=") || raw.length < 11) return raw;
  const b64 = raw.slice(9, -2).replaceAll("-", "+").replaceAll("_", "/").replaceAll("=", "");
  try {
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Method dispatch (shared by both eras)
// ---------------------------------------------------------------------------

type RpcResult = { ok: Obj } | { code: number; message: string; data?: unknown };

async function dispatch(ctx: Session, method: string, params: Obj): Promise<RpcResult> {
  switch (method) {
    case "tools/list":
      return { ok: { tools: await ctx.listTools() } };
    case "tools/call": {
      if (typeof params.name !== "string") {
        return { code: -32602, message: 'Invalid params: tools/call requires a string "name"' };
      }
      return { ok: await ctx.callTool(params.name, isObj(params.arguments) ? params.arguments : {}) };
    }
    default:
      return { code: -32601, message: "Method not found" };
  }
}
