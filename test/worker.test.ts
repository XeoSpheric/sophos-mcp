// The Worker entry point: routing, access control, gateway credentials, the
// MCP protocol eras, and the per-credential state shared across requests.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { checkFusionGraphQLUrl, configFromEnv, gatewayCredentials, verifyBearer, verifyS2s } from "../src/config/config.ts";
import { type HttpResponse, MODERN_VERSION, handle } from "../src/mcp.ts";
import { Session, resetSharedState } from "../src/session.ts";
import { type Obj, hmacSha256Hex } from "../src/util.ts";
import * as entry from "../src/worker.ts";
import worker from "../src/worker.ts";
import { jsonResponse, stubFetch } from "./harness.ts";

const wctx = { waitUntil() {} };
const TENANT = "00000000-0000-4000-8000-000000000001";

const mcpReq = (body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list" }, headers: Record<string, string> = {}) =>
  new Request("https://w.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const callReq = (name: string, args: Obj = {}) => ({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });

/** Answers token, whoami and REST calls for a single-tenant credential; records every URL. */
function fakeSophos(): { urls: string[]; restore: () => void } {
  const urls: string[] = [];
  const restore = stubFetch((url) => {
    urls.push(url);
    if (url.startsWith("https://id.sophos.com/")) return jsonResponse({ access_token: "fake-token", expires_in: 3600, errorCode: "success" });
    if (url.endsWith("/whoami/v1")) {
      return jsonResponse({
        id: TENANT,
        idType: "tenant",
        apiHosts: { global: "https://api.central.sophos.com", dataRegion: "https://api-au01.central.sophos.com" },
      });
    }
    return jsonResponse({ items: [], pages: {} });
  });
  return { urls, restore };
}

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
  resetSharedState();
  configFromEnv({});
});

test("the entry module exports only the default handler", () => {
  // workerd treats every named export as an entrypoint and refuses to start
  // when one isn't a handler.
  assert.deepEqual(Object.keys(entry), ["default"]);
});

test("health, CORS preflight and 404", async () => {
  const health = await worker.fetch(new Request("https://w.example/health"), { AUTH_MODE: "gateway" }, wctx);
  const body = await health.json();
  assert.equal(body.status, "ok");
  assert.equal(body.server, "sophos-central-mcp-server");
  assert.equal(body.authMode, "gateway");
  assert.equal(body.writes, false);
  assert.equal(health.headers.get("access-control-allow-origin"), "*");
  assert.equal((await worker.fetch(new Request("https://w.example/mcp", { method: "OPTIONS" }), {}, wctx)).status, 204);
  assert.equal((await worker.fetch(new Request("https://w.example/nope"), {}, wctx)).status, 404);
});

test("env mode refuses /mcp until an access control secret is set", async () => {
  const r = await worker.fetch(mcpReq(), { SOPHOS_CLIENT_ID: "id", SOPHOS_CLIENT_SECRET: "secret", LOG_LEVEL: "error" }, wctx);
  assert.equal(r.status, 503);
  assert.match((await r.json()).error.message, /MCP_AUTH_TOKEN/);
  // /health stays open
  assert.equal((await worker.fetch(new Request("https://w.example/health"), {}, wctx)).status, 200);
});

test("MCP_AUTH_TOKEN guards /mcp", async () => {
  const env = { MCP_AUTH_TOKEN: "t0ken", LOG_LEVEL: "error" };
  const missing = await worker.fetch(mcpReq(), env, wctx);
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get("www-authenticate"), "Bearer");
  assert.equal((await worker.fetch(mcpReq(undefined, { authorization: "Bearer wrong" }), env, wctx)).status, 401);
  assert.equal((await worker.fetch(mcpReq(undefined, { authorization: "Bearer t0ken" }), env, wctx)).status, 200);
  assert.equal(verifyBearer("bearer t0ken", "t0ken"), true);
  assert.equal(verifyBearer("t0ken", "t0ken"), false);
});

test("CONDUIT_S2S_SECRET guards /mcp", async () => {
  const env = { CONDUIT_S2S_SECRET: "s3cret", LOG_LEVEL: "error" };
  assert.equal((await worker.fetch(mcpReq(), env, wctx)).status, 401);
  const now = Math.floor(Date.now() / 1000);
  const header = `t=${now},v1=${await hmacSha256Hex("s3cret", `t=${now}`)}`;
  assert.equal((await worker.fetch(mcpReq(undefined, { "x-gateway-s2s": header }), env, wctx)).status, 200);
});

test("S2S header verification", async () => {
  const now = 1_800_000_000;
  const good = `t=${now},v1=${await hmacSha256Hex("s3cret", `t=${now}`)}`;
  assert.equal(await verifyS2s(good, "s3cret", now + 299), true);
  assert.equal(await verifyS2s(good, "s3cret", now + 301), false);
  assert.equal(await verifyS2s(good, "other", now), false);
});

test("gateway mode needs both credential headers and never falls back to the secrets", async () => {
  const env = { AUTH_MODE: "gateway", SOPHOS_CLIENT_ID: "operator", SOPHOS_CLIENT_SECRET: "operator-secret" };
  const r = await worker.fetch(mcpReq(undefined, { "x-sophos-client-id": "caller" }), env, wctx);
  assert.equal(r.status, 401);
  assert.deepEqual((await r.json()).required, ["X-Sophos-Client-Id", "X-Sophos-Client-Secret"]);
  const h: Record<string, string> = { "x-sophos-client-id": " id ", "x-sophos-client-secret": "secret" };
  assert.deepEqual(gatewayCredentials((k) => h[k]), { clientId: "id", clientSecret: "secret" });

  const fake = fakeSophos();
  restore = fake.restore;
  const ok = await worker.fetch(
    mcpReq(callReq("sophos_list_alerts"), { "x-sophos-client-id": "caller", "x-sophos-client-secret": "caller-secret" }),
    env,
    wctx,
  );
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).result.isError, undefined);
  const token = fake.urls.find((u) => u.startsWith("https://id.sophos.com/"));
  assert.ok(token, "a token was requested");
});

test("tools/list honours ALLOW_WRITES and works without credentials", async () => {
  const env = { MCP_AUTH_TOKEN: "t", LOG_LEVEL: "error" };
  const auth = { authorization: "Bearer t" };
  const ro = (await (await worker.fetch(mcpReq(undefined, auth), env, wctx)).json()).result.tools as Obj[];
  const rw = (await (await worker.fetch(mcpReq(undefined, auth), { ...env, ALLOW_WRITES: "true" }, wctx)).json()).result.tools as Obj[];
  assert.equal(rw.length, 305, "no credentials: identity unknown, so the partner tools are listed too");
  assert.ok(ro.length > 100 && ro.length < rw.length);
  assert.ok(ro.every((t) => t.annotations?.readOnlyHint === true));

  const call = await (await worker.fetch(mcpReq(callReq("sophos_list_alerts"), auth), env, wctx)).json();
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, /Missing Sophos credentials/);

  const write = await (await worker.fetch(mcpReq(callReq("sophos_delete_case", { case_id: TENANT }), auth), env, wctx)).json();
  assert.equal(write.result.isError, true);
});

test("a write tool is refused with ALLOW_WRITES off, before any request to Sophos", async () => {
  const fake = fakeSophos();
  restore = fake.restore;
  const session = new Session({ clientId: "id", clientSecret: "secret" }, false);
  const r = await session.callTool("sophos_isolate_endpoint", { endpoint_id: TENANT });
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /ALLOW_WRITES is off/);
  assert.ok(fake.urls.every((u) => u.startsWith("https://id.sophos.com/") || u.endsWith("/whoami/v1")));
});

test("a single-tenant credential gets no partner tools, and the identity is fetched once per isolate", async () => {
  const fake = fakeSophos();
  restore = fake.restore;
  const creds = { clientId: "id", clientSecret: "secret" };
  const names = (await new Session(creds, true).listTools()).map((t) => t.name);
  assert.ok(!names.includes("sophos_list_tenants"));
  assert.ok(names.includes("sophos_list_alerts"));
  await new Session(creds, true).listTools();
  assert.equal(fake.urls.filter((u) => u.endsWith("/whoami/v1")).length, 1);
  assert.equal(fake.urls.filter((u) => u.startsWith("https://id.sophos.com/")).length, 1, "the token is shared too");

  // A different secret is a different credential: its own token and identity
  await new Session({ clientId: "id", clientSecret: "other" }, true).listTools();
  assert.equal(fake.urls.filter((u) => u.endsWith("/whoami/v1")).length, 2);
});

test("a failed identity lookup lists every tool and every call reports why", async () => {
  restore = stubFetch(() => jsonResponse({ error: "denied" }, 401));
  const session = new Session({ clientId: "id", clientSecret: "bad" }, true);
  assert.equal((await session.listTools()).length, 305);
  const r = await session.callTool("sophos_list_alerts", {});
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /Sophos identity lookup failed: Sophos auth failed \(401\)/);
});

test("overlapping tool calls in one isolate all succeed", async () => {
  const fake = fakeSophos();
  restore = fake.restore;
  const env = { MCP_AUTH_TOKEN: "t", SOPHOS_CLIENT_ID: "id", SOPHOS_CLIENT_SECRET: "secret", LOG_LEVEL: "error" };
  const results = await Promise.all(
    Array.from({ length: 8 }, () => worker.fetch(mcpReq(callReq("sophos_list_alerts"), { authorization: "Bearer t" }), env, wctx)),
  );
  for (const r of results) {
    assert.equal(r.status, 200);
    assert.equal((await r.json()).result.isError, undefined);
  }
});

test("invalid arguments are a tool error naming the field", async () => {
  const fake = fakeSophos();
  restore = fake.restore;
  const r = await new Session({ clientId: "id", clientSecret: "secret" }, true).callTool("sophos_list_alerts", { limit: 500, tenant_id: "nope" });
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /Invalid arguments for tool sophos_list_alerts: .*tenant_id: Invalid uuid/);
  assert.match(r.content[0]!.text, /limit: Number must be less than or equal to 100/);
});

test("configuration: the Fusion URL override and CHARACTER_LIMIT", async () => {
  for (const ok of ["https://api.taegis.sophos.com/graphql", "https://api.fusion.sophos.com/graphql", "https://sophos.com/graphql"]) {
    assert.equal(checkFusionGraphQLUrl(ok), ok);
  }
  for (const bad of [
    "http://api.taegis.sophos.com/graphql",
    "https://attacker.example/graphql",
    "https://sophos.com.attacker.example/graphql",
    "https://notsophos.com/graphql",
    "not a url",
  ]) {
    assert.throws(() => checkFusionGraphQLUrl(bad), /SOPHOS_FUSION_GRAPHQL_URL/, bad);
  }

  // A bad override refuses /mcp before any request is made
  const fake = fakeSophos();
  restore = fake.restore;
  const r = await worker.fetch(
    mcpReq(callReq("sophos_fusion_list_cases"), { authorization: "Bearer t" }),
    { MCP_AUTH_TOKEN: "t", SOPHOS_CLIENT_ID: "id", SOPHOS_CLIENT_SECRET: "s", SOPHOS_FUSION_GRAPHQL_URL: "https://attacker.example/graphql", LOG_LEVEL: "error" },
    wctx,
  );
  assert.equal(r.status, 500);
  assert.match((await r.json()).error.message, /Invalid SOPHOS_FUSION_GRAPHQL_URL "https:\/\/attacker\.example\/graphql"/);
  assert.deepEqual(fake.urls, []);

  const cfg = configFromEnv({ ALLOW_WRITES: "1", AUTH_MODE: "gateway", MCP_AUTH_TOKEN: "x" });
  assert.equal(cfg.allowWrites, true);
  assert.equal(cfg.gatewayMode, true);
  assert.equal(cfg.envCreds, undefined);
  const { CHARACTER_LIMIT } = await import("../src/config/config.ts");
  configFromEnv({ CHARACTER_LIMIT: "500" });
  assert.equal((await import("../src/config/config.ts")).CHARACTER_LIMIT, 10000, "minimum 10000");
  configFromEnv({ CHARACTER_LIMIT: "80000" });
  assert.equal((await import("../src/config/config.ts")).CHARACTER_LIMIT, 80000);
  assert.equal(typeof CHARACTER_LIMIT, "number");
});

// ---------------------------------------------------------------------------
// MCP protocol (src/mcp.ts)
// ---------------------------------------------------------------------------

const INFO = { name: "sophos-central-mcp-server", version: "test", instructions: "hi" };
const ACCEPT: [string, string] = ["accept", "application/json, text/event-stream"];

function request(method: string, body: string, headers: [string, string][], session = new Session(undefined, false)) {
  const h = new Map(headers.map(([k, v]) => [k.toLowerCase(), v]));
  return handle(INFO, session, { method, body, header: (k) => h.get(k.toLowerCase()) });
}

function post(body: unknown, headers: [string, string][] = [], session?: Session): Promise<HttpResponse> {
  return request("POST", JSON.stringify(body), [["content-type", "application/json"], ...headers], session);
}

function sseJson(r: HttpResponse): Obj {
  const line = r.body.split("\n").findLast((l) => l.startsWith("data:"))!;
  return JSON.parse(line.slice("data:".length).trim());
}

test("legacy initialize over SSE advertises tools only", async () => {
  const r = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } }, [ACCEPT]);
  assert.equal(r.contentType, "text/event-stream");
  const v = sseJson(r);
  assert.equal(v.result.protocolVersion, "2025-06-18");
  assert.deepEqual(Object.keys(v.result.capabilities), ["tools"]);
  assert.equal(v.result.serverInfo.name, "sophos-central-mcp-server");
  assert.equal(v.result.instructions, "hi");
});

test("unknown methods, bad content type and non-POST", async () => {
  assert.equal(JSON.parse((await post({ jsonrpc: "2.0", id: 3, method: "resources/list" })).body).error.code, -32601);
  assert.equal((await request("POST", "{}", [["content-type", "text/plain"]])).status, 415);
  assert.equal((await request("GET", "", [])).status, 405);
  assert.equal((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
});

const envelope = (): Obj => ({
  "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
  "io.modelcontextprotocol/clientCapabilities": {},
});

test("modern server/discover and tools/call", async () => {
  const base: [string, string][] = [["mcp-protocol-version", MODERN_VERSION]];
  let r = await post({ jsonrpc: "2.0", id: "d", method: "server/discover", params: { _meta: envelope() } }, [...base, ["mcp-method", "server/discover"]]);
  assert.deepEqual(JSON.parse(r.body).result.supportedVersions, [MODERN_VERSION]);
  r = await post(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "sophos_list_alerts", arguments: {}, _meta: envelope() } },
    [...base, ["mcp-method", "tools/call"], ["mcp-name", "sophos_list_alerts"]],
  );
  const v = JSON.parse(r.body);
  assert.equal(v.result.resultType, "complete");
  assert.equal(v.result.isError, true); // no credentials
});
