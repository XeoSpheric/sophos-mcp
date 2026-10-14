# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run typecheck   # tsc-rs (Rust port of the TypeScript compiler), strict, no emit
npm test            # node:test runs the .ts sources directly (no network; fetch is stubbed)
npm run build       # wrangler deploy --dry-run into dist-dry-run/ (bundle check)
npm run dev         # local workerd via wrangler dev; copy .dev.vars.example to .dev.vars
npm run deploy      # wrangler deploy
MCP_URL=... MCP_AUTH_TOKEN=... node scripts/fusion-smoke.mjs [tenant-id]   # Live check over MCP HTTP against a running Worker (default http://localhost:8787/mcp); read-only unless --write, --write-classic or --all (those need ALLOW_WRITES=true)
```

`npm run typecheck`, `npm test` and `npm run build` are the verification steps. Fix all type errors and keep the tests green before considering a change complete. The tests stub `fetch`; nothing in them reaches Sophos.

Dependency-free TypeScript Cloudflare Worker, modelled on `~/autotask-mcp` and `~/datto-rmm-mcp` (see `CONTRIBUTING.md`). No runtime dependencies; dev dependencies are `tsc-rs` and `wrangler` only. Node 24+ for the tests (native type stripping). There is no stdio transport, no npm package and no `.mcpb` bundle any more.

## Naming

The product is Sophos Fusion (formerly Sophos Central). Human-facing titles and descriptions say "Sophos Fusion (formerly Sophos Central)". The `package.json` name and the MCP `serverInfo` name stay `sophos-central-mcp-server` so clients keyed on the server name keep working; the Worker is `sophos-mcp` in `wrangler.json`. Never write "Sophos Taegis": `api.taegis.sophos.com` is a hostname, and the product it came from is Secureworks Taegis. Use the developer portal's wording for the query language: "Fusion Query Language (QL)".

## Architecture

A **Model Context Protocol (MCP) server** on Cloudflare Workers that wraps the Sophos Central REST APIs and the Sophos Fusion GraphQL APIs. Erasable TypeScript only (`erasableSyntaxOnly`: no enums, namespaces or constructor parameter properties) so Node runs the sources unbundled; relative imports carry their `.ts` extension. No `@types/node`: the tests use the Node slice in `test/node.d.ts`, and `src/` uses only Web APIs (fetch, WebCrypto, TextEncoder, atob/btoa). No filesystem.

### Request flow

1. `src/worker.ts` (entry; only `export default`, because workerd treats every named export as an entrypoint): OPTIONS is the CORS preflight, `GET /health` is open, everything else but `/mcp` is 404
2. `configFromEnv(env)` (`src/config/config.ts`) reads vars and secrets and sets the module settings (`CHARACTER_LIMIT`, `SOPHOS_FUSION_GRAPHQL_URL`, `CLASSIC_MIGRATION_CHECK`, ESM live bindings). A bad `SOPHOS_FUSION_GRAPHQL_URL` is a 500 before any request to Sophos
3. Access control on `/mcp`: `MCP_AUTH_TOKEN` (bearer) and/or `CONDUIT_S2S_SECRET` (`X-Gateway-S2S` HMAC). In env mode at least one must be set or `/mcp` answers 503, because a workers.dev URL is public and the secrets are the operator's Sophos credentials
4. Credentials: `AUTH_MODE=gateway` takes `X-Sophos-Client-Id` / `X-Sophos-Client-Secret` per request (missing is a 401, never a fall back to the secrets); otherwise the `SOPHOS_CLIENT_ID` / `SOPHOS_CLIENT_SECRET` secrets
5. `src/mcp.ts` handles both protocol eras (2025 JSON-RPC with `initialize`, SSE single-shot replies; 2026-07-28 with `server/discover`) and dispatches `tools/list` and `tools/call` to a per-request `Session` (`src/session.ts`)
6. The Session builds the clients on the credential's shared state, resolves the caller identity (`/whoami/v1`, cached per credential), then registers every tool on a fresh `ToolRegistry`. `sophos_list_tenants`, the partner tools and the bulk health tools are registered unless the caller is known to be a single tenant. Without credentials, or when whoami fails, every tool is listed and every call returns the reason
7. `ALLOW_WRITES` (default off; Worker Previews always off): tools not annotated `readOnlyHint: true` are left out of tools/list and refused on call

### Workers rules

- **Never let one request await a promise another request created.** Module-level state is plain data only: `SharedState` per credential (keyed on a hash of id and secret) holds the token (`TokenStore`), identity and tenant map (`TenancyStore`, list reloaded after 15 minutes) and the Fusion case reference data map. `TokenManager`, `TenantResolver`, `CaseReferenceDataCache` and the clients are built per request, so their in-flight promises are request scoped.
- Per request cost is about 1.3 ms CPU to register the 305 tools; that is fine, do not cache the registry across requests (it closes over request-scoped clients).
- Bulk tools (`sophos_list_account_health`, `sophos_partner_gap_analysis`) fan out one subrequest per tenant; that needs the paid Workers plan's subrequest limit for large partners.

### Core classes

- **`TokenManager`** (`src/auth/token-manager.ts`): OAuth2 client credentials flow; the token lives in the shared `TokenStore` (60s early refresh); concurrent refreshes within a request are deduplicated.
- **`TenantResolver`** (`src/client/tenant-resolver.ts`): caller identity and `tenantId -> TenantInfo` map in the shared `TenancyStore`. Key methods: `init()`, `resolveTenantId(providedId?)`, which enforces that partner/org callers must supply a tenant ID; `resolveApiHost(tenantId)`, which returns the per-tenant regional REST host; `loadTenants()`; `isMultiTenant()` (true while the identity is unknown). Fusion calls use `resolveTenantId` only; there is no regional host.
- **`SophosClient`** (`src/client/sophos-client.ts`): Two methods, `tenantRequest<T>(tenantId, path, opts)` and `globalRequest<T>(path, opts)`. Both first run `assertSafeApiPath`, which refuses a path where an interpolated ID carries a `.` or `..` segment (after percent-decoding), `?`, `#`, a backslash, an encoded `/` or a control character; query strings go in `params`, never the path. Both inject auth headers and run `executeWithRetry` (2 retries, exponential backoff, respects `Retry-After` on 429, no retry on 4xx). A POST is retried only on 429: after a 5xx, a timeout or a dropped connection it may already have taken effect, so the error says so instead.
- **`FusionClient`** (`src/client/fusion-client.ts`): `query<T>(tenantId, document, variables)` POSTs to `SOPHOS_FUSION_GRAPHQL_URL` with the bearer token and `X-Tenant-ID`. Same transport retry shape as the REST client (30 s timeout, 2 retries, `Retry-After` on 429, no retry on 4xx, and a mutation retried only on 429) with full-jitter backoff, plus the one GraphQL-layer retry described below. Returns `{ data, warnings }`. `putPresigned(url, bytes, contentType)` is the plain PUT behind case file uploads.
- **`FusionMigrationGuard`** (`src/fusion/migration.ts`): `assertClassic(tenantId, classicTool, useInstead)` throws when the tenant has moved to Fusion (the case reference cache returns at least one case type; an unmigrated tenant gets an empty list with no error) and returns warnings otherwise. Every Classic case and detection handler calls it first. `SOPHOS_CLASSIC_MIGRATION_CHECK=off` disables it.
- **`ToolRegistry`** (`src/tools/registry.ts`): the `registerTool(name, { title, description, inputSchema, annotations }, handler)` surface the tool modules use; builds the tools/list payload, validates `tools/call` arguments against the shape (unknown keys dropped, defaults applied, `Invalid arguments for tool <name>: <path>: <message>` tool error) and applies the write gate.
- **`src/schema.ts`**: a dependency-free, zod-shaped schema builder. Tool files `import * as z from "../schema.ts"` and write `z.string().uuid().optional().describe(...)`; it renders JSON Schema and validates with zod 3 semantics (no coercion except `z.coerce.number()`, chain-ordered `.trim()` / `.toLowerCase()`). Supported: `string` (uuid, email, url, regex, startsWith, datetime, min, max, trim, toLowerCase), `number` (int, min, max), `coerce.number`, `boolean`, `enum`, `literal`, `union`, `array` (min, max), `object`, `record`, `unknown`, and `optional`, `default`, `describe` on all; `z.infer`. Add a method there before using a new zod feature.

### The GraphQL 200 rule

A GraphQL-layer failure comes back as **HTTP 200 with an `errors` array** beside `data`. `FusionClient` never treats a 200 as success until the body has been read:

- `errors` present and no usable data (data null, or every root field null): throws `FusionGraphQLError` with every message joined. Never retried.
- `errors` present beside usable data (a partial response, typically a federated field): returns the data with the messages in `warnings`. Tools attach `warnings` to their result; they are never dropped.
- A null root field with no errors passes through for the tool to report as not found. In practice an unknown case ID arrives as errors (`record not found`) beside `data: { case: null }`, which the first rule throws; `FusionGraphQLError.notFound` recognises it and the case tools translate it into their not-found message.
- The `extensions.code` cannot tell a transient failure from a rejected query: `conn busy`, `record not found` and `query not valid for any known schema type(s)` all carry `DOWNSTREAM_SERVICE_ERROR`. So the code is never used to decide a retry.
- The one GraphQL-layer retry is keyed on the error path. `createCase` and `addEvidenceToCase` fail 74% of the time with `not allowed`, `path: ["partnerPreferences"]`, from `investigations-v2`; the identical call succeeds on retry (111 faults in 150 calls, measured on a live tenant 22/09/2026, drifting from 60% to 85% across four samples). `updateCase` does not carry the fault, 0 in 30. `FusionGraphQLError.isTransientPartnerPreferences` is `errors[0].path[0] === "partnerPreferences"` and nothing else; `query()` retries only that, up to 20 attempts with a short capped backoff. An error carrying the operation name in its path (`createCase`, `addEvidenceToCase`, `tdrusers`) is a real input or permission error and surfaces at once.

Transport failures (expired token, 429, 5xx) use the usual non-2xx status and the standard Sophos error object. A query the schema rejects is HTTP 400 with a GraphQL `errors` array and no data; the client keeps that message. A missing required variable is HTTP 200 with `errors` (`BAD_USER_INPUT`) and no `data` key at all.

### Fusion layout (`src/fusion/`)

- `queries/<api>.ts`: hand-written GraphQL documents as string constants, one file per API, minimal selection sets, no codegen. Operation names use the `detection*` form, never the `alertsService*` aliases. Federated `*Subject` fields are not selected. Never put two case-scoped root fields in one document (`case` plus `caseEvidence`, or two aliased `case` fields): investigations-v2 answers `conn busy` every time. The three reference-data root fields are fine together.
- `case-reference-data.ts`: `CaseReferenceDataCache`, per tenant, 15 minute TTL, one round trip for case types, primary statuses and primary verdicts. Fusion filters and writes these by UUID and the set depends on the tenant's licensed services, so names resolve at runtime and are never hard-coded.
- `cases-ql.ts`: builds the QL string for `cases(arguments: { query })` from the list tool's filters. Names never reach QL; only `*Id` columns are searchable.
- `format.ts`: severity scales (case 2 to 10 integer; detection 0 to 1 float; Classic REST detection 0 to 10; never converted), `{ seconds, nanos }` to ISO 8601, ID shape checks (UUID, `CSE#####` short ID, legacy `1-598868`, six section resource names for detection and event IDs), QL quoting, comment mention parsing, tag merging, the detection row formatter.
- `migration.ts`: the migration guard (above).
- `types.ts`: response types for the selected fields.
- `schemas/fusion/*.graphql` (repo root): the five schemas exactly as downloaded from the developer portal on 21/09/2026, for reference and diffing. Do not edit them; re-download to update.

Fusion and Classic cases are separate sets. A legacy ID never resolves in Fusion and a Fusion ID never resolves in REST; the tools refuse the wrong shape with a pointer to the other family. There is no delete in Fusion: close (with a verdict when the type supports one), then archive.

Measured case rules the tools enforce or explain (live tenant, 22/09/2026): `managedBy` is required on create, never defaulted (omitting it makes an unclaimed case) and immutable, and `health_check` and `threat_hunt` pin it to `PROVIDER`; `keyFindings.documentVersion` is exactly `"1.0"`; tags on update replace, so the tool merges unless told to replace; a closed case is frozen apart from status, verdicts, secondary status, archive and reasons; an archived case refuses every update; a closed case with a verdict reopens only when the same update clears the verdict (`primaryVerdictId: ""` clears it; `null` satisfies the rule but leaves the stored verdict in place); `new` is a one way door; a closed case refuses title, severity, assignee, key findings and tag changes, and the tool refuses those before any write rather than reopening on the caller's behalf. Evidence: detection and event IDs are six section RNs; adding a detection also attaches its asset and events and removing it does not retract them; `removeEvidenceFromCase` takes source IDs (an entry `id` is a silent no-op); evidence jobs are queued and land category by category (an add showed after about 5 s, a three category removal took about 25 s), so read backs must poll. Comments: `AddCaseComment` has no `Input` suffix; `@authorized_contacts`, `@customer` and `@sophos` fire wherever they appear and unknown tokens are dropped silently, so the tools read `mentionsIds` back; never select `authorSubject` or `mentionsSubjects` (they turn the response into an error). Files: `caseFiles` is tenant wide with no `query` (client-side filter by `caseId`), `deleteCaseFile` is soft. `casePrimaryStatuses` returns six statuses while case types list eight, so status IDs degrade to the raw ID rather than throwing.

### Tool registration pattern

Each file in `src/tools/` exports a `register*Tools(server: ToolRegistry, client, tenantResolver)` function (`cases.ts` and `detections.ts` take the migration guard as a fourth parameter; `fusion-cases.ts` takes `(server, fusionClient, tenantResolver, caseReferenceData)`; `fusion-detections.ts` takes `(server, fusionClient, tenantResolver)`). `registerAllTools` in `src/session.ts` calls them all. Tools follow this pattern:

```typescript
server.registerTool(
  "sophos_tool_name",
  { title, description, inputSchema: { /* z fields from ../schema.ts */ }, annotations: { readOnlyHint, destructiveHint, ... } },
  withErrorHandling(async (args) => {
    const tenantId = tenantResolver.resolveTenantId(args.tenant_id);
    const data = await client.tenantRequest<ResponseType>(tenantId, "/api/path", { params, method, body });
    return jsonResult(formatData(data));
  })
);
```

Every tool must set `annotations`; `readOnlyHint: true` is what keeps it available with `ALLOW_WRITES` off. Tools cannot touch a filesystem: take content as text or base64 and return links, not paths (`sophos_download_firewall_backup` returns the pre-signed `download_url`; `sophos_import_firewall_config` takes `source_url` or `content_base64`; `sophos_fusion_upload_case_file` takes `content` or `content_base64`).

Helper functions in `src/tools/helpers.ts`:
- `jsonResult(data)`: JSON-serialises and truncates at `CHARACTER_LIMIT` with a truncation notice
- `errorResult(error)`: formats errors as MCP error responses
- `withErrorHandling(handler)`: wraps handlers to catch and return errors cleanly

Byte helpers (`utf8Bytes`, `base64ToBytes`, `bytesToBase64`, `md5Hex`, `sleep`, `sha256Hex`) live in `src/util.ts`; there is no `Buffer`.

### Adding a new tool

1. Create (or add to) a file in `src/tools/`
2. Add Sophos API response types to `src/types/sophos.ts` (REST) or `src/fusion/types.ts` (GraphQL) if needed
3. Export a `register*Tools(...)` function
4. Call it from `registerAllTools` in `src/session.ts`
5. All tenant-scoped tools must call `tenantResolver.resolveTenantId(args.tenant_id)` first; this throws with a useful message for partner/org callers who omit `tenant_id`
6. Fusion tools take the `sophos_fusion_` prefix, name the severity scale a field uses, give one working QL example where a query is accepted, and batch ID lookups (the rate limit is per credential and shared with the Central tools)
7. Update the counts in `test/tool-registration.test.ts` and `test/worker.test.ts`, then run `npm run typecheck && npm test && npm run build`

### Pagination

- Endpoint APIs use cursor-based pagination (`pageFromKey` / `nextKey`)
- Most other REST APIs use offset-based pagination (`page` / `pageSize`)
- Fusion cases accept offset (`page` / `perPage`, max 100) or cursor (`first` / `after`) pagination; cursors are opaque and replayed verbatim
- `DEFAULT_PAGE_SIZE = 50`, `MAX_PAGE_SIZE = 100` from `src/config/config.ts`

### Constants (`src/config/config.ts`)

| Constant | Value |
|---|---|
| `SOPHOS_AUTH_URL` | `https://id.sophos.com/api/v2/oauth2/token` |
| `SOPHOS_GLOBAL_API` | `https://api.central.sophos.com` |
| `SOPHOS_FUSION_GRAPHQL_URL` | `https://api.taegis.sophos.com/graphql`, env override of the same name (https on a `sophos.com` host only, checked in `configFromEnv`) |
| `CHARACTER_LIMIT` | `50000` (env override, minimum 10000) |
| `DEFAULT_PAGE_SIZE` | `50` |

### Worker vars and secrets

Secrets: `SOPHOS_CLIENT_ID`, `SOPHOS_CLIENT_SECRET`, `MCP_AUTH_TOKEN`, `CONDUIT_S2S_SECRET`. Vars (`wrangler.json`): `AUTH_MODE` (`env` or `gateway`), `ALLOW_WRITES`, `LOG_LEVEL`, `LOG_FORMAT`, and optionally `CHARACTER_LIMIT`, `SOPHOS_FUSION_GRAPHQL_URL`, `SOPHOS_CLASSIC_MIGRATION_CHECK`, `MCP_SERVER_NAME`, `MCP_SERVER_VERSION`. `previews.vars` force gateway mode and no writes.

## Prose

README, CLAUDE.md and tool descriptions carry no em dashes and no en dashes. Keep them short.
