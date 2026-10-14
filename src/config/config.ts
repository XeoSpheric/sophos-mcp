// Worker configuration (vars/secrets), request authentication helpers and the
// Sophos API constants. Kept out of src/worker.ts: Workers treats every named
// export of the entry module as an entrypoint and refuses to start if one
// isn't a handler.

import pkg from "../../package.json" with { type: "json" };
import type { Credentials } from "../auth/token-manager.ts";
import { constantTimeEq, hmacSha256Hex } from "../util.ts";

export const VERSION: string = pkg.version;

// Sophos Central global API endpoints
export const SOPHOS_AUTH_URL = "https://id.sophos.com/api/v2/oauth2/token";
export const SOPHOS_GLOBAL_API = "https://api.central.sophos.com";

// Sophos Fusion GraphQL endpoint. One host for every tenant, no regional
// lookup. The override exists so the Fusion branded hostnames expected in
// November 2026 need no code change.
export const DEFAULT_FUSION_GRAPHQL_URL = "https://api.taegis.sophos.com/graphql";

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

// Settings read from the Worker env. They are the same for every request in
// an isolate, so configFromEnv sets these module bindings and the modules
// that import them see the current value (ESM live bindings).

/** Response size limit for tool results (CHARACTER_LIMIT, minimum 10000). */
export let CHARACTER_LIMIT = 50000;
/** GraphQL endpoint the Fusion tools post to (SOPHOS_FUSION_GRAPHQL_URL). */
export let SOPHOS_FUSION_GRAPHQL_URL = DEFAULT_FUSION_GRAPHQL_URL;
/**
 * Migration awareness for the Classic Cases and Detections REST tools. A
 * tenant that has moved to Sophos Fusion is refused on those tools and pointed
 * at the sophos_fusion_* equivalent, because for such a tenant the Classic
 * APIs answer from the pre-migration Sophos Central objects. Set
 * SOPHOS_CLASSIC_MIGRATION_CHECK=off to skip the check.
 */
export let CLASSIC_MIGRATION_CHECK = true;

/**
 * The bearer token is sent to SOPHOS_FUSION_GRAPHQL_URL, so the override must
 * be an https URL on a sophos.com host, or the Worker refuses to serve.
 */
export function checkFusionGraphQLUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid SOPHOS_FUSION_GRAPHQL_URL "${value}": not a URL.`);
  }
  const host = url.hostname;
  if (url.protocol !== "https:" || (host !== "sophos.com" && !host.endsWith(".sophos.com"))) {
    throw new Error(
      `Invalid SOPHOS_FUSION_GRAPHQL_URL "${value}": it must be an https URL on a sophos.com host, because the Sophos bearer token is sent to it.`,
    );
  }
  return value;
}

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Mcp-Method, Mcp-Name, X-Sophos-Client-Id, X-Sophos-Client-Secret",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

export type Env = Record<string, string | undefined>;

/** Workers `ExecutionContext` (only the part we use). */
export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Configuration read from Worker vars/secrets. */
export interface Config {
  gatewayMode: boolean;
  envCreds: Credentials | undefined;
  allowWrites: boolean;
  /** When set, /mcp requires `Authorization: Bearer <token>`. */
  authToken: string;
  s2sSecret: string;
  serverName: string;
  serverVersion: string;
}

const isTrue = (v: string | undefined) => v === "true" || v === "1";

/** Read the Worker env and apply the module settings. Throws on an invalid value. */
export function configFromEnv(env: Env): Config {
  const get = (k: string) => (typeof env[k] === "string" && env[k] ? env[k] : undefined);

  const limit = Number.parseInt(get("CHARACTER_LIMIT") ?? "50000", 10);
  CHARACTER_LIMIT = Math.max(10000, Number.isFinite(limit) ? limit : 50000);
  SOPHOS_FUSION_GRAPHQL_URL = checkFusionGraphQLUrl(get("SOPHOS_FUSION_GRAPHQL_URL") ?? DEFAULT_FUSION_GRAPHQL_URL);
  CLASSIC_MIGRATION_CHECK = (get("SOPHOS_CLASSIC_MIGRATION_CHECK") ?? "on").toLowerCase() !== "off";

  const clientId = get("SOPHOS_CLIENT_ID");
  const clientSecret = get("SOPHOS_CLIENT_SECRET");
  return {
    gatewayMode: get("AUTH_MODE") === "gateway",
    envCreds: clientId && clientSecret ? { clientId, clientSecret } : undefined,
    allowWrites: isTrue(get("ALLOW_WRITES")),
    authToken: get("MCP_AUTH_TOKEN") ?? "",
    s2sSecret: get("CONDUIT_S2S_SECRET") ?? "",
    serverName: get("MCP_SERVER_NAME") ?? "sophos-central-mcp-server",
    serverVersion: get("MCP_SERVER_VERSION") ?? VERSION,
  };
}

/** Gateway credentials from request headers; undefined when either is missing. */
export function gatewayCredentials(header: (name: string) => string | null | undefined): Credentials | undefined {
  const h = (k: string) => header(k)?.trim() || undefined;
  const clientId = h("x-sophos-client-id");
  const clientSecret = h("x-sophos-client-secret");
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

/** Check `Authorization: Bearer <token>` against MCP_AUTH_TOKEN. */
export function verifyBearer(header: string | null | undefined, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? "");
  return m !== null && constantTimeEq(m[1]!, token);
}

/** Verify the gateway's `t=<secs>,v1=<hex hmac>` S2S header. */
export async function verifyS2s(header: string | null | undefined, secret: string, nowSecs: number): Promise<boolean> {
  if (!header || !secret) return false;
  const m = /^t=(\d{1,15}),v1=([0-9a-f]{64})$/.exec(header);
  if (!m) return false;
  const ts = Number(m[1]);
  if (Math.abs(nowSecs - ts) > 300) return false;
  return constantTimeEq(m[2]!, await hmacSha256Hex(secret, `t=${ts}`));
}
