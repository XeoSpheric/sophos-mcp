// In-process MCP client for tool tests: register tools on a fresh registry
// and call them the way an MCP client would (argument validation, the write
// gate, the error envelope), with no transport.
//
//   const client = connect((server) => registerFusionCaseTools(server, fake, resolver, cache));
//   const result = await client.callTool({ name: "sophos_fusion_get_case", arguments: { case_id } });

import type { ToolResult } from "../src/tools/helpers.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import type { Obj } from "../src/util.ts";

export interface TestClient {
  registry: ToolRegistry;
  callTool(req: { name: string; arguments?: Obj }): Promise<ToolResult>;
  listTools(): Promise<{ tools: Obj[] }>;
}

export function connect(register: (server: ToolRegistry) => void, opts: { allowWrites?: boolean } = {}): TestClient {
  const registry = new ToolRegistry();
  register(registry);
  const allowWrites = opts.allowWrites ?? true;
  return {
    registry,
    callTool: (req) => registry.call(req.name, req.arguments ?? {}, allowWrites),
    listTools: async () => ({ tools: registry.list(allowWrites) }),
  };
}

/** The text of a tool result's first content item. */
export function text(result: ToolResult): string {
  return result.content[0]?.text ?? "";
}

/** A tool result's text parsed as JSON. */
export function json(result: ToolResult): any {
  return JSON.parse(text(result));
}

/** Install a fetch stub for the rest of the test; returns the restore function. */
export function stubFetch(fn: (url: string, init: RequestInit) => Response | Promise<Response>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    fn(input instanceof Request ? input.url : String(input), init ?? {})) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}
