// Cloudflare Workers entry point for the Sophos Fusion (formerly Sophos
// Central) MCP server.
//
// Routes:
//   OPTIONS *            CORS preflight (204)
//   GET /health(z)       unauthenticated liveness probe
//   *   /mcp             MCP Streamable HTTP, both protocol eras (see mcp.ts)
//
// Access to /mcp, checked in order:
//   MCP_AUTH_TOKEN       when set, requires `Authorization: Bearer <token>`.
//   CONDUIT_S2S_SECRET   when set, requires a valid X-Gateway-S2S header
//                        (HMAC-SHA256 over `t=<unix seconds>`, 5 minute skew).
//   In env mode at least one of them must be set, or /mcp refuses every
//   request: the secrets are the operator's own Sophos credentials, and a
//   workers.dev URL is public.
//
// Sophos credentials, per request:
//   AUTH_MODE=gateway  X-Sophos-Client-Id / X-Sophos-Client-Secret headers;
//                      missing headers are a 401, never a fall-through to the
//                      operator's own credentials.
//   otherwise          SOPHOS_CLIENT_ID / SOPHOS_CLIENT_SECRET secrets.
// tools/list and initialize work without credentials; tool calls return a
// tool error until they're configured.
//
// ALLOW_WRITES=true lists and enables the write tools (every tool not
// annotated readOnlyHint); otherwise the server is read-only.
//
// Only `export default` here: workerd treats every named export of the entry
// module as an entrypoint and refuses to start if one isn't a handler.

import { type Config, type Env, type ExecutionContext, CORS_HEADERS, configFromEnv, gatewayCredentials, verifyBearer, verifyS2s } from "./config/config.ts";
import { configureLog, log } from "./log.ts";
import { handle } from "./mcp.ts";
import { Session } from "./session.ts";
import { isoNow } from "./util.ts";

function respond(status: number, contentType: string | undefined, body: string, extra: Record<string, string> = {}): Response {
  const headers = new Headers(CORS_HEADERS);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  if (contentType) {
    headers.set("Content-Type", contentType);
    if (contentType === "text/event-stream") headers.set("Cache-Control", "no-cache, no-transform");
  }
  return new Response(body || null, { status, headers });
}

const jsonResp = (status: number, body: unknown, extra?: Record<string, string>) =>
  respond(status, "application/json", JSON.stringify(body), extra);

const rpcError = (status: number, code: number, message: string, extra?: Record<string, string>) =>
  jsonResp(status, { jsonrpc: "2.0", error: { code, message }, id: null }, extra);

const unauthorized = (message: string, extra?: Record<string, string>) => rpcError(401, -32001, `Unauthorized: ${message}`, extra);

export default {
  async fetch(req: Request, env: Env, _wctx: ExecutionContext): Promise<Response> {
    configureLog(env.LOG_LEVEL, env.LOG_FORMAT);
    const path = new URL(req.url).pathname;
    if (req.method === "OPTIONS") return respond(204, undefined, "");

    let cfg: Config;
    try {
      cfg = configFromEnv(env);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.error(`Invalid configuration: ${message}`);
      return rpcError(500, -32603, `Server misconfigured: ${message}`);
    }

    if (path === "/health" || path === "/healthz") {
      return jsonResp(200, {
        status: "ok",
        server: cfg.serverName,
        version: cfg.serverVersion,
        authMode: cfg.gatewayMode ? "gateway" : "env",
        writes: cfg.allowWrites,
        timestamp: isoNow(),
      });
    }
    if (path !== "/mcp") return jsonResp(404, { error: "Not found", endpoints: ["/mcp", "/health"] });

    if (!cfg.gatewayMode && !cfg.authToken && !cfg.s2sSecret) {
      log.error("Refused /mcp: env mode with neither MCP_AUTH_TOKEN nor CONDUIT_S2S_SECRET set");
      return rpcError(
        503,
        -32000,
        "Server not configured: set MCP_AUTH_TOKEN (or CONDUIT_S2S_SECRET) before serving the operator's Sophos credentials.",
      );
    }
    if (cfg.authToken && !verifyBearer(req.headers.get("authorization"), cfg.authToken)) {
      log.warn("Rejected request with missing/invalid bearer token");
      return unauthorized("missing or invalid bearer token", { "WWW-Authenticate": "Bearer" });
    }
    if (cfg.s2sSecret && !(await verifyS2s(req.headers.get("x-gateway-s2s"), cfg.s2sSecret, Math.floor(Date.now() / 1000)))) {
      log.warn("Rejected request with missing/invalid gateway S2S header");
      return unauthorized("missing or invalid gateway S2S authentication header");
    }

    let creds = cfg.envCreds;
    if (cfg.gatewayMode) {
      creds = gatewayCredentials((k) => req.headers.get(k));
      if (!creds) {
        return jsonResp(401, {
          error: "Missing credentials",
          message: "Gateway mode requires X-Sophos-Client-Id and X-Sophos-Client-Secret headers",
          required: ["X-Sophos-Client-Id", "X-Sophos-Client-Secret"],
        });
      }
    }

    const resp = await handle(
      { name: cfg.serverName, version: cfg.serverVersion, instructions: "" },
      new Session(creds, cfg.allowWrites),
      {
        method: req.method.toUpperCase(),
        header: (k) => req.headers.get(k)?.trim() ?? undefined,
        body: req.method === "POST" ? await req.text().catch(() => "") : "",
      },
    );
    return respond(resp.status, resp.contentType, resp.body);
  },
};
