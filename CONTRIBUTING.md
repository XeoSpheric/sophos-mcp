# Contributing

## Getting started

```sh
npm ci
npm run typecheck   # tsc-rs (Rust port of the TypeScript compiler)
npm test            # node:test, runs the .ts sources directly
npm run build       # wrangler deploy --dry-run, into dist-dry-run/
npm run dev         # local workerd (see .dev.vars.example)
```

Node 24+ is required (native TypeScript type stripping).

Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`,
`fix:`, `docs:`, `chore:`) and open pull requests against `main`. The
typecheck, tests and bundle must be clean.

## Constraints

- **No runtime dependencies.** Dev dependencies are `tsc-rs` and `wrangler`
  only. Small helpers are hand-written in `src/util.ts`; tool schemas use the
  zod-shaped builder in `src/schema.ts`; Node test typings are the slice in
  `test/node.d.ts`, not `@types/node`.
- **Erasable TypeScript only** (`erasableSyntaxOnly`): no enums, namespaces or
  constructor parameter properties, so Node can run the sources unbundled.
  Relative imports carry their `.ts` extension.
- **Web APIs only in `src/`**: fetch, WebCrypto, TextEncoder, atob/btoa. No
  `Buffer`, no filesystem.
- **The entry module (`src/worker.ts`) only has `export default`.** workerd
  treats every named export as an entrypoint and refuses to start.
- **Never share a promise across requests.** Module-level state holds plain
  data only (`SharedState` in `src/session.ts`); anything that can hold an
  in-flight promise is built per request.

## Layout

| Path | What |
|---|---|
| `src/worker.ts` | Worker entry: routing, CORS, access control, credentials |
| `src/mcp.ts` | MCP JSON-RPC over Streamable HTTP (legacy and 2026-07-28 eras) |
| `src/session.ts` | Per-request session, per-credential shared state, tool registration |
| `src/schema.ts` | Zod-shaped schema builder: JSON Schema and argument validation |
| `src/config/config.ts` | Env vars and secrets, auth helpers, Sophos constants |
| `src/auth/`, `src/client/` | OAuth token, tenant resolution, REST and GraphQL clients |
| `src/fusion/` | Fusion GraphQL documents, QL builder, reference data, formatting |
| `src/tools/` | `registry.ts` (ToolRegistry), `helpers.ts`, one module per API area |
| `test/` | `node:test` suites; `harness.ts` is the in-process MCP client |

Adding a tool: register it in a module under `src/tools/` with
`annotations` set (`readOnlyHint: true` keeps it available when
`ALLOW_WRITES` is off), make sure `registerAllTools` in `src/session.ts`
calls the module, and update the counts in `test/tool-registration.test.ts`
and `test/worker.test.ts`.

## Tests

Assert on the request actually sent to Sophos, not only on the result.

```ts
import { connect, json, stubFetch, jsonResponse } from "./harness.ts";
const restore = stubFetch((url, init) => jsonResponse({ items: [] }));
const client = connect((server) => registerAlertTools(server, sophosClient, resolver));
const result = await client.callTool({ name: "sophos_list_alerts", arguments: {} });
```

`resetSharedState()` from `src/session.ts` clears cached tokens and
identities between Worker-level tests.

## License

MIT, see `LICENSE`.
