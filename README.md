# Sophos Fusion MCP Server (formerly Sophos Central)

> **Unofficial project, not from Sophos.** This is a personal project by an individual. It is
> not an official Sophos product and it is not built, endorsed, supported, or warranted by
> Sophos. It calls the public Sophos APIs using credentials you supply. Use it at your own
> risk, and raise problems as issues on this repository rather than with Sophos support.

MCP (Model Context Protocol) server for the Sophos Fusion (formerly Sophos Central) APIs. Supports partner, organisation, and single-tenant credential types with automatic region routing. **305 tools** covering 22 Sophos API namespaces: the Sophos Central REST APIs plus the Sophos Fusion GraphQL APIs (`sophos_fusion_*`). It runs as a dependency-free TypeScript Cloudflare Worker that speaks MCP over streamable HTTP.

The Worker is named `sophos-mcp` in `wrangler.json`. The MCP server name it reports stays `sophos-central-mcp-server`.

## Prerequisites

### Sophos API credentials

You need a Client ID and Client Secret. The same credential authorises both the Sophos Central REST tools and the Sophos Fusion GraphQL tools; there is no second credential. The credential type decides what the server can see:

- **Tenant-level**: In Sophos Central, go to **Settings > API Credentials Management** and create a new credential. The server operates on that one tenant.
- **Partner-level**: In the Sophos Partner Dashboard, create API credentials under **Settings > API Credentials**. The server can query every tenant the partner manages.
- **Organisation-level**: In Sophos Central Enterprise, use **Global Settings > API Credentials Management**. Same cross-tenant behaviour as partner credentials.

### Cloudflare account

You need a Cloudflare account to deploy the Worker. Development needs Node.js 24 or later, which runs the TypeScript sources directly through native type stripping. The only dev dependencies are `tsc-rs` (a Rust port of the TypeScript compiler) and `wrangler`.

## Deploy

```bash
git clone https://github.com/XeoSpheric/sophos-mcp.git
cd sophos-mcp
npm ci

npx wrangler secret put SOPHOS_CLIENT_ID
npx wrangler secret put SOPHOS_CLIENT_SECRET
npx wrangler secret put MCP_AUTH_TOKEN        # or CONDUIT_S2S_SECRET

npm run deploy
```

Make the token with something like `openssl rand -hex 32`. In the default `env` mode `/mcp` refuses every request (503) until `MCP_AUTH_TOKEN` or `CONDUIT_S2S_SECRET` is set. A `workers.dev` URL is public and the secrets are your own Sophos credentials, so there is no open mode.

Connect a client to `https://sophos-mcp.<account>.workers.dev/mcp` and have it send `Authorization: Bearer <token>`. In Claude Code:

```bash
claude mcp add --transport http sophos https://sophos-mcp.<account>.workers.dev/mcp --header "Authorization: Bearer <token>"
```

Write tools are hidden and refused until you set `ALLOW_WRITES` to `true`. See [Configuration](#configuration).

### Endpoints

- `POST /mcp`: MCP Streamable HTTP, stateless. It serves both the 2025-era JSON-RPC protocol (the `initialize` handshake, with single-shot SSE replies when the client accepts `text/event-stream`) and the 2026-07-28 protocol (`server/discover`).
- `GET /health` (or `/healthz`): unauthenticated. Returns `{status, server, version, authMode, writes, timestamp}`.
- `OPTIONS`: CORS preflight, with `Access-Control-Allow-Origin: *`.

Without credentials, `initialize` and `tools/list` still work (all tools are listed) and a tool call returns a "Missing Sophos credentials" tool error. For a tenant credential the partner and organisation only tools are not listed.

### Local development

```bash
npm ci
cp .dev.vars.example .dev.vars   # then fill in credentials
npm run dev                      # local workerd via wrangler dev, http://localhost:8787/mcp
```

| Command | What it does |
|---------|--------------|
| `npm run typecheck` | Type check with `tsc-rs` |
| `npm test` | Run the `node:test` suites on the `.ts` sources directly. `fetch` is stubbed; nothing reaches Sophos |
| `npm run build` | `wrangler deploy --dry-run`, output in `dist-dry-run/` |
| `npm run dev` | Local Worker, reads `.dev.vars` |
| `npm run deploy` | `wrangler deploy` |

### Tests (maintainers)

`npm test` runs these suites in `test/`, with `fetch` stubbed: Worker routing, access control, gateway mode and both protocol versions; the schema builder; the Fusion GraphQL transport (including the HTTP 200 with `errors` case); the QL builder; the reference-data cache; the path-keyed retry for the intermittent case-write fault; the migration guard; the policy assignment and web profile writes (body shapes, refusals, target lookups and read-back) against an in-memory policy store; the no-retry rule for a POST or mutation after a 5xx; the read-modify-write and PATCH update tools; the request shapes of the tools checked against the published specs; a registration check that lists all 305 tools and checks the descriptions for the measured warnings; and the reworked firewall backup, firewall import and case file upload tools. Nothing in `npm test` reaches Sophos.

To exercise the Fusion tools against a live tenant, start a Worker (`npm run dev`, with credentials in `.dev.vars`) and run:

```bash
node scripts/fusion-smoke.mjs                  # read-only, tenant credential
node scripts/fusion-smoke.mjs <tenant-id>      # read-only, partner or organisation credential
node scripts/fusion-smoke.mjs --write          # plus the Fusion write tools on one new case
node scripts/fusion-smoke.mjs --write-classic  # plus the Classic case tools on one new case
node scripts/fusion-smoke.mjs --all            # everything
```

It talks MCP over HTTP to the running Worker, so what runs is what a client gets. Set `MCP_URL` (default `http://localhost:8787/mcp`) and `MCP_AUTH_TOKEN` to match the Worker. The write modes need `ALLOW_WRITES=true` on the Worker. Read-only mode covers the reference data, the case list with filter and cursor variants, the newest case by short ID, its evidence, summary, comments and files, the detection search, the not-found and legacy-ID refusals, and the Classic side: on a migrated tenant the migration refusal, otherwise the six Classic read tools. `--write` creates one case titled `MCP smoke test <timestamp>` (managed_by CUSTOMER), exercises comment add, edit and delete with the mention read-back, link create, update and delete, tag merge and replace, evidence add and remove_all, file upload, list and soft delete, the verdict clear on reopen, the one way door on new and the closed-case freeze, then closes it with a verdict and archives it (Fusion has no delete). `--write-classic` creates, updates and deletes one Classic case; the Cases API requires an assignee and a detection that still exists, so set `SMOKE_CLASSIC_ASSIGNEE` (a tenant admin email) and, if needed, `SMOKE_CLASSIC_DETECTION_ID` (a recent detection ID). Every write is listed at the end. Existing cases are never modified.

## Features

- **Universal caller support**: Works with partner, organisation, and tenant-level API credentials
- **Multi-tenant**: Partner/org callers can query across all managed tenants
- **Partner gap analysis**: Single-call sales opportunity report across all managed tenants. Fetches health data in parallel and returns a compact ranked list of security gaps per customer
- **Auto region routing**: Discovers tenant data regions via `/whoami/v1` and routes requests to the correct regional API host
- **Token lifecycle**: Automatic OAuth2 token refresh before expiry
- **Rate limit handling**: Retry with backoff on 429 responses
- **Cloudflare Worker**: No runtime dependencies, stateless streamable HTTP, deployed with `wrangler`
- **Read-only by default**: write tools are hidden and refused until `ALLOW_WRITES=true`
- **Two API generations**: the Sophos Central REST APIs and the Sophos Fusion GraphQL APIs on one credential, with `sophos_fusion_*` tools for the GraphQL side
- **Migration aware**: the Classic case and detection tools refuse a tenant that has moved to Sophos Fusion and name the `sophos_fusion_*` tool to use instead
- **Full API coverage**: 305 tools across endpoints, alerts, policies, firewalls, web filtering, licensing, audit events, email, mobile, XDR, cases, SIEM, and more

## Screenshots

**Querying tenants and drilling into endpoint status:**

![Tenant listing and endpoint staleness check](docs/screenshots/tenant-listing.png)

**Tenant health audit with full category breakdown:**

![Tenant health overview](docs/screenshots/tenant-health-overview.png)

![Tenant health detail and endpoints](docs/screenshots/tenant-health-detail.png)

## Configuration

Set secrets with `wrangler secret put <NAME>` and variables in `wrangler.json` under `vars`. For `npm run dev`, put both in `.dev.vars` (see `.dev.vars.example`).

| Name | Kind | Default | Description |
|------|------|---------|-------------|
| `SOPHOS_CLIENT_ID`, `SOPHOS_CLIENT_SECRET` | secrets | - | Sophos API credential (partner, organisation or tenant). Required in `env` mode |
| `MCP_AUTH_TOKEN` | secret | - | When set, `/mcp` needs `Authorization: Bearer <token>` |
| `CONDUIT_S2S_SECRET` | secret | - | When set, `/mcp` needs a valid `X-Gateway-S2S` header: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "t=<secs>">`, within 5 minutes of the Worker clock |
| `AUTH_MODE` | var | `env` | `env` uses the secrets above. `gateway` means every request brings its own credentials in `X-Sophos-Client-Id` and `X-Sophos-Client-Secret` headers; missing headers are a 401, never a fall back to the secrets. Worker Previews run in gateway mode |
| `ALLOW_WRITES` | var | `false` | Write tools (every tool not annotated `readOnlyHint`) are hidden from `tools/list` and refused unless `true`. Previews are always read-only. With it off, 157 of the 305 tools are listed |
| `CHARACTER_LIMIT` | var | 50000 | Maximum characters per tool response before truncation (minimum 10000) |
| `SOPHOS_FUSION_GRAPHQL_URL` | var | `https://api.taegis.sophos.com/graphql` | Sophos Fusion GraphQL endpoint. Must be `https` on a `sophos.com` host, since the bearer token goes to it; the Worker refuses to serve otherwise |
| `SOPHOS_CLASSIC_MIGRATION_CHECK` | var | on | `off` skips the migration check on the Classic case and detection tools (they then run for every tenant) |
| `LOG_LEVEL` | var | `info` | `error`, `warn`, `info` or `debug` |
| `LOG_FORMAT` | var | `json` | `json` or `simple` |
| `MCP_SERVER_NAME`, `MCP_SERVER_VERSION` | var | - | Override the server name and version the Worker reports |

In `env` mode `/mcp` returns 503 until `MCP_AUTH_TOKEN` or `CONDUIT_S2S_SECRET` is set.

The caller identity (`/whoami/v1`), the OAuth token, the tenant list (reloaded after 15 minutes) and the Fusion case reference data (15 minute TTL) are cached per credential, per Worker isolate, as plain data.

## Tools

### Two API generations

The server speaks to two Sophos API generations on one credential:

- **Sophos Central REST APIs** (retained). Every tool without the `fusion` prefix. Regional hosts, discovered from `/whoami/v1`.
- **Sophos Fusion GraphQL APIs** (new, 18/09/2026). The `sophos_fusion_*` tools. One endpoint, `https://api.taegis.sophos.com/graphql`, same token, same `X-Tenant-ID` header. Filters are written in Fusion Query Language (QL). Case types, statuses and verdicts are tenant reference data resolved to IDs at runtime, case severity is an integer (2 to 10), and assignees are Subject IDs, not email addresses. A GraphQL failure arrives as HTTP 200 with an `errors` array; the client treats that as an error, and a partial response (data plus errors) is returned with a `warnings` list rather than as a clean result.

Sophos is moving tenants to Fusion over the coming months (the [upgrade centre](https://community.sophos.com/sophos-xdr/sophos-xdr-mdr-expansion/upgrade-center) announces each account's slot). This is a point in time change, not a fallback: once a tenant has moved, the Classic Cases and Detections REST APIs reference the pre-migration Sophos Central objects, so their answers are wrong rather than stale. The Classic tools therefore check which world a tenant is in before every call, using the Fusion case reference data (a tenant that has not moved gets an empty case type list), and refuse a migrated tenant with a message naming the `sophos_fusion_*` tool to use. For a tenant that has not moved they stay correct and carry no deprecation label. Fusion holds a separate case set (a UUID plus a `CSE#####` short ID) and neither ID form resolves in the other API. Live Discover and XDR Query are unaffected. Data Lake search over GraphQL has not shipped (Sophos says October 2026), so `sophos_run_xdr_query` stays on the SQL XDR Query API. Fusion tools for events, threat timeline and live endpoint search are planned.

Two Fusion case writes, `createCase` and `addEvidenceToCase`, fail 74% of the time with `not allowed` on `partnerPreferences` from `investigations-v2`. It is an intermittent downstream fault, not authorisation: the identical call succeeds on retry, and `updateCase` does not carry the fault at all. Measured on a live tenant 22/09/2026: 111 faults in 150 calls, drifting from 60% to 85% across four samples six minutes apart. The client retries a call whose first error path is `partnerPreferences`, and only that, up to 20 times with a short backoff, which leaves about 1 call in 410 failing at the measured rate and about 1 in 26 at the worst rate observed; an error naming the operation in its path is a real input or permission error and surfaces at once.

### Partner & Organisation (17 tools)

> These tools are only available with **partner or organisation-level** credentials. They operate across all managed tenants.

| Tool | Description |
|------|-------------|
| `sophos_list_tenants` | List all managed tenants with IDs, names, and data regions |
| `sophos_create_tenant` | Create a new managed tenant |
| `sophos_get_managed_tenant` | Get managed tenant details |
| `sophos_list_partner_roles` | List partner-level roles |
| `sophos_get_partner_role` | Get partner role detail |
| `sophos_create_partner_role` | Create a partner role |
| `sophos_delete_partner_role` | Delete a partner role |
| `sophos_list_partner_permission_sets` | List available partner permission sets |
| `sophos_list_partner_admins` | List partner administrators |
| `sophos_get_partner_admin` | Get partner admin detail |
| `sophos_create_partner_admin` | Create a partner admin |
| `sophos_delete_partner_admin` | Delete a partner admin |
| `sophos_list_partner_admin_role_assignments` | List admin role assignments |
| `sophos_add_partner_admin_role_assignment` | Add role assignment to admin |
| `sophos_delete_partner_admin_role_assignment` | Remove role assignment |
| `sophos_get_billing_usage` | Get billing usage for a specific month |
| `sophos_get_billing_summary` | Billing usage for a month, totalled per customer |

### Alerts (4 tools)

| Tool | Description |
|------|-------------|
| `sophos_list_alerts` | List alerts with severity/category/product/date filters |
| `sophos_get_alert` | Get full alert detail with allowed actions |
| `sophos_acknowledge_alert` | Mark an alert as reviewed |
| `sophos_search_alerts` | Advanced search with structured filters and sorting |

### Endpoints (18 tools)

| Tool | Description |
|------|-------------|
| `sophos_list_endpoints` | List endpoints with health/OS/hostname/isolation filters |
| `sophos_get_endpoint` | Get full endpoint detail |
| `sophos_scan_endpoint` | Trigger an on-demand scan |
| `sophos_isolate_endpoint` | Network-isolate a compromised endpoint |
| `sophos_release_endpoint` | Release an endpoint from isolation |
| `sophos_delete_endpoint` | Delete a specific endpoint |
| `sophos_bulk_delete_endpoints` | Bulk delete multiple endpoints |
| `sophos_get_tamper_protection` | Get tamper protection status and password |
| `sophos_toggle_tamper_protection` | Enable/disable tamper protection |
| `sophos_get_adaptive_attack_protection` | Get adaptive attack protection status |
| `sophos_toggle_adaptive_attack_protection` | Enable/disable adaptive attack protection |
| `sophos_trigger_update_check` | Trigger a software update check |
| `sophos_request_forensic_logs` | Request forensic log upload |
| `sophos_get_forensic_log_status` | Get forensic log request status |
| `sophos_request_memory_dump` | Request memory dump from endpoint |
| `sophos_get_memory_dump_status` | Get memory dump request status |
| `sophos_bulk_isolate_endpoints` | Bulk isolate/release multiple endpoints |
| `sophos_get_endpoint_isolation_status` | Get endpoint isolation status |

### Endpoint Settings (26 tools)

| Tool | Description |
|------|-------------|
| `sophos_list_installer_downloads` | List available installer packages |
| `sophos_list_blocked_addresses` | List blocked network addresses |
| `sophos_add_blocked_address` | Add a blocked network address |
| `sophos_delete_blocked_address` | Delete a blocked address |
| `sophos_list_local_sites` | List web control local site definitions |
| `sophos_add_local_site` | Add a local site for web control |
| `sophos_update_local_site` | Update a local site |
| `sophos_delete_local_site` | Delete a local site |
| `sophos_list_web_control_categories` | List web control categories |
| `sophos_get_tls_decryption_settings` | Get TLS decryption settings |
| `sophos_update_tls_decryption_settings` | Update TLS decryption settings |
| `sophos_get_global_tamper_protection` | Get global tamper protection settings |
| `sophos_list_detected_exploits` | List detected exploits |
| `sophos_get_detected_exploit` | Get exploit detail |
| `sophos_list_exploit_mitigation_categories` | List exploit mitigation categories |
| `sophos_get_exploit_mitigation_category` | Get category detail |
| `sophos_list_exploit_mitigation_apps` | List exploit mitigation applications |
| `sophos_get_exploit_mitigation_app` | Get application detail |
| `sophos_add_exploit_mitigation_app` | Add application to exploit mitigation |
| `sophos_update_exploit_mitigation_app` | Update exploit mitigation application |
| `sophos_list_ips_exclusions` | List IPS exclusions |
| `sophos_add_ips_exclusion` | Add IPS exclusion |
| `sophos_delete_ips_exclusion` | Delete IPS exclusion |
| `sophos_list_isolation_exclusions` | List isolation exclusions |
| `sophos_add_isolation_exclusion` | Add isolation exclusion |
| `sophos_delete_isolation_exclusion` | Delete isolation exclusion |

### Endpoint Migrations (6 tools)

| Tool | Description |
|------|-------------|
| `sophos_list_migrations` | List endpoint migration jobs |
| `sophos_get_migration` | Get migration job details |
| `sophos_create_migration` | Create a new migration job |
| `sophos_list_migration_endpoints` | List endpoints in a migration |
| `sophos_list_recommended_packages` | List recommended software packages |
| `sophos_list_static_packages` | List static software packages |

### Policies (7 tools)

| Tool | Description |
|------|-------------|
| `sophos_list_policies` | List endpoint policies with optional type filter |
| `sophos_get_policy` | Get full policy detail including all settings and assignments |
| `sophos_create_policy` | Create a new endpoint policy, optionally assigned |
| `sophos_clone_policy` | Clone an existing policy under a new name, optionally with a new assignment |
| `sophos_update_policy` | Update policy name, enabled state, priority, settings, or the whole assignment |
| `sophos_set_policy_assignments` | Replace, add or remove a policy's users, user groups, endpoints or endpoint groups |
| `sophos_delete_policy` | Delete a policy |

Assignments take plain ID arrays. A policy applies either to users and user groups (a user policy) or to endpoints and endpoint groups (a device policy), never both; the kind follows which keys you send. Server policies take only server endpoints and groups, and computer policies only computer ones: the IDs are looked up first, because Sophos accepts a server on a computer policy without ever applying it. Endpoint groups are always sent with an `endpoints` key, because Sophos answers 500 to endpoint groups on their own. Every assignment write is read back by ID and the result shows what Sophos stored. A new policy can take up to about 25 seconds to show in `sophos_list_policies`; `sophos_get_policy` is current at once.

Web profiles: setting `endpoint.web-control.web-profile-id` also sends `filter-by-web-profile.enabled` true, without which Sophos keeps the old value, and turns on `web-profile.enabled` unless you set it. A new web control policy gets `web-profile.enabled` set explicitly (true with a profile, false for legacy settings) instead of the API's default of true. The settings are read back after the write. A profile is linked from the policy side; the profile tools do not send `consumers`, which Sophos ignores.

### Endpoint Groups (7 tools)

| Tool | Description |
|------|-------------|
| `sophos_list_endpoint_groups` | List endpoint groups |
| `sophos_get_endpoint_group` | Get group detail with optional member list |
| `sophos_create_endpoint_group` | Create a new endpoint group |
| `sophos_update_endpoint_group` | Rename or update a group |
| `sophos_delete_endpoint_group` | Delete an endpoint group |
| `sophos_add_endpoints_to_group` | Add endpoints to a group |
| `sophos_remove_endpoint_from_group` | Remove an endpoint from a group |

### Exclusions & Allow/Block Lists (9 tools)

| Tool | Description |
|------|-------------|
| `sophos_list_exclusions` | List global scanning exclusions |
| `sophos_add_exclusion` | Add a scanning exclusion |
| `sophos_delete_exclusion` | Delete a scanning exclusion |
| `sophos_list_allowed_items` | List globally allowed items |
| `sophos_add_allowed_item` | Allow an item by SHA256, path, or certificate |
| `sophos_delete_allowed_item` | Remove an allowed item |
| `sophos_list_blocked_items` | List globally blocked items |
| `sophos_add_blocked_item` | Block an item by SHA256, path, or certificate |
| `sophos_delete_blocked_item` | Remove a blocked item |

### Account Health (3 tools)

| Tool | Description |
|------|-------------|
| `sophos_get_account_health` | Get tenant health check scores |
| `sophos_list_account_health` | Bulk health scores for all tenants (partner/org only) |
| `sophos_partner_gap_analysis` | Gap analysis across all tenants (partner/org only) |

### Directory Users & Groups (16 tools)

| Tool | Description |
|------|-------------|
| `sophos_list_users` | List directory users |
| `sophos_get_user` | Get user detail |
| `sophos_create_user` | Create a directory user |
| `sophos_update_user` | Update a user |
| `sophos_delete_user` | Delete a user |
| `sophos_list_user_groups` | List directory user groups |
| `sophos_get_user_group` | Get user group detail |
| `sophos_create_user_group` | Create a user group |
| `sophos_update_user_group` | Update a user group |
| `sophos_delete_user_group` | Delete a user group |
| `sophos_list_user_group_members` | List members of a user group |
| `sophos_add_users_to_group` | Add users to a group |
| `sophos_remove_user_from_group` | Remove a user from a group |
| `sophos_list_user_group_policies` | List policies assigned to a user group |
| `sophos_list_admins` | List admin accounts and roles |
| `sophos_list_roles` | List available admin roles |

### Admin Management (12 tools)

| Tool | Description |
|------|-------------|
| `sophos_get_admin` | Get admin detail |
| `sophos_create_admin` | Create an admin account |
| `sophos_delete_admin` | Delete an admin account |
| `sophos_list_admin_role_assignments` | List admin's role assignments |
| `sophos_add_admin_role_assignment` | Add role assignment to admin |
| `sophos_delete_admin_role_assignment` | Remove role assignment |
| `sophos_get_admin_role_assignment` | Get specific role assignment |
| `sophos_create_role` | Create an admin role |
| `sophos_get_role` | Get role detail |
| `sophos_update_role` | Update a role |
| `sophos_delete_role` | Delete a role |
| `sophos_list_permission_sets` | List available permission sets |

### Cases (9 tools)

Sophos Central Cases REST API. Correct for a tenant that has not moved to Fusion, and the only way to read its legacy cases (IDs like `1-598868`). Refused for a tenant that has moved, with a pointer to the `sophos_fusion_*` tool to use (see "Two API generations").

| Tool | Description |
|------|-------------|
| `sophos_list_cases` | List investigation cases |
| `sophos_get_case` | Get full case details |
| `sophos_create_case` | Create a new investigation case (the API requires an assignee and a detection that still exists) |
| `sophos_update_case` | Update case status, severity, assignee |
| `sophos_delete_case` | Delete a case |
| `sophos_list_case_detections` | List detections linked to a case |
| `sophos_get_case_detection` | Get specific detection detail |
| `sophos_list_case_impacted_entities` | List impacted entities for a case |
| `sophos_get_case_mitre_summary` | Get MITRE ATT&CK breakdown for a case |

### Fusion Cases (21 tools)

Sophos Fusion Cases GraphQL API v2. Case IDs are UUIDs; short IDs (`CSE00001`) are accepted and resolved. Severity is 2 informational, 4 low, 6 medium, 8 high, 10 critical. Detection severity inside the case summary is a 0 to 1 float, a different scale from both the case severity and the Classic REST 0 to 10 detection severity; none of them convert. There is no delete: close the case (with a verdict when its type needs one), then archive it.

`managed_by` is required on create and decides who works the case: `PROVIDER` hands it to Sophos MDR, `CUSTOMER` keeps it self managed. It cannot be changed afterwards, and a case created without it is unclaimed, so the tool never omits it. Detection and event IDs on the evidence tools are six section resource names (`alert://priv:event-filter:123456:1789526908712:<uuid>`), which `sophos_fusion_search_detections` returns. Evidence writes are queued jobs that land category by category (an add showed after about 5 seconds, a three category removal took about 25 seconds), so read the evidence back with a poll; adding a detection also attaches its linked asset and events, and removing it does not retract them (`remove_all` does). Comment @mentions (`@authorized_contacts`, `@customer`, `@sophos`) fire wherever they appear, including in prose, and an unrecognised token is dropped silently, so the comment tools read the stored mentions back. Tags are merged on update unless `replace_tags` is set. File deletion is soft. Split and merge are irreversible and need a confirmation argument.

| Tool | Description |
|------|-------------|
| `sophos_fusion_list_cases` | List cases with QL filters (type, status, verdict resolved to IDs), offset or cursor pagination |
| `sophos_fusion_get_case` | Full case detail including key findings, verdict, links and processing status |
| `sophos_fusion_get_case_evidence` | Detection, event, asset and saved-search source IDs attached to a case |
| `sophos_fusion_get_case_summary` | Case plus its detections resolved in one batched call and a MITRE ATT&CK roll-up |
| `sophos_fusion_list_case_reference_data` | The tenant's case types, primary statuses and verdicts (15 minute cache) |
| `sophos_fusion_create_case` | Create a case: required managed_by, type and status by name or ID, integer severity, Markdown key findings, genesis evidence |
| `sophos_fusion_update_case` | Update fields, merge or replace tags, close with a verdict, reopen (verdict cleared), archive or unarchive; refuses frozen fields on a closed case rather than reopening it |
| `sophos_fusion_split_case` | Move named evidence into a new case (irreversible, confirm_split) |
| `sophos_fusion_merge_cases` | Merge source cases into a target and close them (asynchronous, irreversible, confirm_merge) |
| `sophos_fusion_list_case_comments` | List comments (raw author IDs, resolved mentions, read state) |
| `sophos_fusion_add_case_comment` | Add a comment and report which @mentions actually fired |
| `sophos_fusion_update_case_comment` | Edit a comment or mark it read |
| `sophos_fusion_delete_case_comment` | Delete a comment |
| `sophos_fusion_add_case_evidence` | Attach detections, events, hosts or saved searches (asynchronous, RNs checked) |
| `sophos_fusion_remove_case_evidence` | Detach evidence by source ID, or everything with remove_all (asynchronous) |
| `sophos_fusion_list_case_files` | List a case's files (deleted hidden by default, download URLs on request) |
| `sophos_fusion_upload_case_file` | Attach a file from `content` or `content_base64` (exactly one; `name` required): register, PUT to the presigned URL, poll to UPLOADED |
| `sophos_fusion_delete_case_file` | Soft delete a file |
| `sophos_fusion_create_case_link` | Attach an external link (ServiceNow ticket, report) |
| `sophos_fusion_update_case_link` | Change a link's URL, title, type or reference |
| `sophos_fusion_delete_case_link` | Remove a link |

### Fusion Detections (1 tool)

Sophos Fusion Detections GraphQL API v2. One QL search replaces the Classic run, poll, results triple. Source keyword `alert`; working example `from alert severity >= 0.1 EARLIEST=-90d`. Severity is a 0 to 1 float.

| Tool | Description |
|------|-------------|
| `sophos_fusion_search_detections` | Search detections with QL; returns the resource-name IDs the case evidence tools take |

### Detections (6 tools)

Sophos Central Detections REST API, async: start a query, poll for completion, then fetch results. Refused for a tenant that has moved to Fusion, with a pointer to `sophos_fusion_search_detections`.

| Tool | Description |
|------|-------------|
| `sophos_run_detections_query` | Start async query for individual detections |
| `sophos_get_detections_run` | Poll detection query status |
| `sophos_get_detections_results` | Fetch completed detection query results |
| `sophos_run_detection_groups_query` | Start async query for grouped detections |
| `sophos_get_detection_groups_run` | Poll detection groups query status |
| `sophos_get_detection_groups_results` | Fetch completed detection groups results |

### SIEM (2 tools)

| Tool | Description |
|------|-------------|
| `sophos_list_siem_events` | Stream security events (cursor-based, last 24h default) |
| `sophos_list_siem_alerts` | Stream security alerts (cursor-based, last 24h default) |

### XDR Data Lake (9 tools)

Async API: submit SQL queries against historical telemetry.

| Tool | Description |
|------|-------------|
| `sophos_run_xdr_query` | Start async SQL query against the Data Lake |
| `sophos_get_xdr_query_run` | Poll XDR query run status |
| `sophos_get_xdr_query_results` | Fetch completed XDR query results |
| `sophos_list_xdr_query_runs` | List XDR query runs |
| `sophos_cancel_xdr_query_run` | Cancel a running XDR query |
| `sophos_list_xdr_query_categories` | List XDR query categories |
| `sophos_get_xdr_query_category` | Get XDR query category detail |
| `sophos_list_xdr_queries` | List saved XDR queries |
| `sophos_get_xdr_query` | Get saved XDR query detail |

### Live Discover (4 tools)

Async API: run OSquery SQL on live endpoints. Rate limited to 10 runs/minute, 500/day.

| Tool | Description |
|------|-------------|
| `sophos_list_live_discover_queries` | List available saved OSquery queries |
| `sophos_run_live_discover_query` | Run a saved or ad hoc query on live endpoints |
| `sophos_get_live_discover_run` | Poll Live Discover run status |
| `sophos_get_live_discover_results` | Fetch Live Discover results |

### Firewall (21 tools)

| Tool | Description |
|------|-------------|
| `sophos_list_firewalls` | List managed firewalls |
| `sophos_update_firewall` | Update firewall properties |
| `sophos_delete_firewall` | Delete a firewall |
| `sophos_firewall_action` | Perform an action (approveManagement, the only documented action) |
| `sophos_check_firmware_upgrade` | Check firmware upgrades for a set of firewalls |
| `sophos_start_firmware_upgrade` | Start or schedule firmware upgrades |
| `sophos_cancel_firmware_upgrade` | Cancel scheduled firmware upgrades |
| `sophos_list_firewall_groups` | List firewall groups |
| `sophos_get_firewall_group` | Get firewall group detail |
| `sophos_create_firewall_group` | Create a firewall group |
| `sophos_update_firewall_group` | Update a firewall group |
| `sophos_delete_firewall_group` | Delete a firewall group |
| `sophos_get_firewall_sync_status` | Get sync status of the firewalls in a group |
| `sophos_get_threat_feed_settings` | Get a firewall's MDR threat feed |
| `sophos_update_threat_feed_settings` | Update a firewall's MDR threat feed settings |
| `sophos_search_threat_feed_indicators` | Search a firewall's MDR threat feed indicators |
| `sophos_get_firewall_transaction` | Poll a per-firewall transaction (threat feed ops) |
| `sophos_export_firewall_config` | Start a config export (backup) of a firewall |
| `sophos_get_firewall_import_export_transaction` | Poll an export/import transaction |
| `sophos_download_firewall_backup` | Check a finished backup and return `download_url`, `expires_at`, `file_size_bytes` and `checksum_md5` (read-only; the URL is a secret until it expires) |
| `sophos_import_firewall_config` | Import a config archive into firewalls, from exactly one of `source_url` (https, fetched with no Sophos token) or `content_base64` |

Config import/export requires the firewall to run SFOS v22 MR2 or later, be
managed by Sophos Central, and hold an active license. On an HA pair, target
the primary node (the auxiliary rejects config operations). The exported
archive can appear in storage a couple of minutes after the transaction
reports finished; `sophos_download_firewall_backup` fetches the archive from the
pre-signed URL to confirm it is there, retrying for about 3 minutes to cover that
window. The Worker has no local disk, so it returns the link instead of saving
a file. Pass that `download_url` as `source_url` to `sophos_import_firewall_config`.

### Email Protection (29 tools)

| Tool | Description |
|------|-------------|
| `sophos_search_quarantine` | Search quarantined emails |
| `sophos_preview_quarantine_message` | Preview quarantined email content |
| `sophos_get_quarantine_urls` | Get URLs in quarantined email |
| `sophos_get_quarantine_attachments` | Get quarantined email attachment info |
| `sophos_release_quarantine_message` | Release quarantined email to recipient |
| `sophos_delete_quarantine_message` | Permanently delete quarantined email |
| `sophos_strip_quarantine_attachments` | Strip attachments and release |
| `sophos_reattach_quarantine_attachments` | Reattach stripped attachments |
| `sophos_download_quarantine_attachment` | Download specific attachment |
| `sophos_search_post_delivery_quarantine` | Search post-delivery quarantine |
| `sophos_preview_post_delivery_message` | Preview post-delivery quarantined message |
| `sophos_get_post_delivery_attachments` | Get post-delivery attachment info |
| `sophos_release_post_delivery_message` | Release post-delivery message |
| `sophos_delete_post_delivery_message` | Delete post-delivery message |
| `sophos_download_post_delivery_attachment` | Download post-delivery attachment |
| `sophos_clawback_message` | Clawback/recall a delivered message |
| `sophos_get_clawback_status` | Get clawback action status |
| `sophos_list_mailboxes` | List mailboxes |
| `sophos_create_mailbox` | Create a mailbox |
| `sophos_bulk_create_mailboxes` | Bulk create mailboxes |
| `sophos_get_mailbox` | Get mailbox detail |
| `sophos_update_mailbox` | Update a mailbox |
| `sophos_delete_mailbox` | Delete a mailbox |
| `sophos_list_mailbox_aliases` | List mailbox aliases |
| `sophos_add_mailbox_alias` | Add a mailbox alias |
| `sophos_delete_mailbox_alias` | Delete a mailbox alias |
| `sophos_list_mailbox_delegates` | List mailbox delegates |
| `sophos_add_mailbox_delegate` | Add a mailbox delegate |
| `sophos_delete_mailbox_delegate` | Remove a mailbox delegate |

### Mobile Device Management (32 tools)

| Tool | Description |
|------|-------------|
| `sophos_get_mobile_auto_enrollment` | Get auto-enrollment settings |
| `sophos_update_mobile_auto_enrollment` | Update auto-enrollment settings (keeps what you leave out) |
| `sophos_list_mobile_os` | List supported mobile OS platforms |
| `sophos_list_mobile_devices` | List mobile devices with filters |
| `sophos_get_mobile_device` | Get device detail |
| `sophos_create_mobile_device` | Create a mobile device |
| `sophos_update_mobile_device` | Update device properties (keeps what you leave out) |
| `sophos_delete_mobile_device` | Delete/unenroll a device |
| `sophos_list_mobile_device_properties` | Get device properties |
| `sophos_get_mobile_device_compliance` | Get compliance status |
| `sophos_get_mobile_device_scans` | Get scan results |
| `sophos_get_mobile_device_policies` | Get assigned policies |
| `sophos_get_mobile_device_apps` | Get installed apps |
| `sophos_get_mobile_device_location` | Get device location |
| `sophos_list_mobile_device_groups` | List device groups |
| `sophos_get_mobile_device_group` | Get device group detail |
| `sophos_create_mobile_device_group` | Create a device group |
| `sophos_update_mobile_device_group` | Update a device group (keeps what you leave out) |
| `sophos_delete_mobile_device_group` | Delete a device group |
| `sophos_sync_mobile_device` | Sync a device |
| `sophos_request_mobile_device_logs` | Request device logs |
| `sophos_scan_mobile_device` | Trigger device scan |
| `sophos_unenroll_mobile_device` | Unenroll a device |
| `sophos_send_mobile_device_message` | Send message to device |
| `sophos_locate_mobile_device` | Request device location update |
| `sophos_lock_mobile_device` | Lock device remotely |
| `sophos_wipe_mobile_device` | Wipe device remotely |
| `sophos_list_mobile_app_groups` | List app groups |
| `sophos_get_mobile_app_group` | Get app group detail |
| `sophos_create_mobile_app_group` | Create an app group |
| `sophos_update_mobile_app_group` | Rename an app group or replace its app list |
| `sophos_delete_mobile_app_group` | Delete an app group |

### DNS Protection (5 tools)

| Tool | Description |
|------|-------------|
| `sophos_list_dns_locations` | List DNS protection locations |
| `sophos_get_dns_location` | Get location detail |
| `sophos_create_dns_location` | Create a DNS location |
| `sophos_update_dns_location` | Update a DNS location |
| `sophos_delete_dns_location` | Delete a DNS location |

### Cloud Security (6 tools)

| Tool | Description |
|------|-------------|
| `sophos_list_cloud_security_profiles` | List cloud security profiles |
| `sophos_list_cloud_security_default_contents` | List the content versions a new profile can use |
| `sophos_get_cloud_security_profile` | Get profile detail |
| `sophos_create_cloud_security_profile` | Create a runtime detection profile or a new version of one |
| `sophos_update_cloud_security_profile` | Rename a profile |
| `sophos_delete_cloud_security_profile` | Delete a profile |

### Wi-Fi (3 tools)

| Tool | Description |
|------|-------------|
| `sophos_list_wifi_mac_filters` | List Wi-Fi MAC filtering entries |
| `sophos_add_wifi_mac_filter` | Add a MAC filter entry |
| `sophos_delete_wifi_mac_filter` | Delete a MAC filter entry |

### User Activity (2 tools)

| Tool | Description |
|------|-------------|
| `sophos_create_attestation` | Create a user attestation/sign-off |
| `sophos_get_attestation` | Get attestation detail |

### Audit Events (1 tool)

| Tool | Description |
|------|-------------|
| `sophos_list_audit_events` | List Sophos Central audit events (who did what, 90-day window) |

### Licensing (2 tools)

| Tool | Description |
|------|-------------|
| `sophos_list_licenses` | List a tenant's product licenses, usage, and entitlements |
| `sophos_list_firewall_licenses` | List firewall license details (tenant or partner-wide) |

### Web Filtering (16 tools)

| Tool | Description |
|------|-------------|
| `sophos_list_web_filtering_profiles` | List web filtering profiles |
| `sophos_get_web_filtering_profile` | Get a web filtering profile |
| `sophos_create_web_filtering_profile` | Create a web filtering profile |
| `sophos_update_web_filtering_profile` | Update a web filtering profile (keeps what you leave out) |
| `sophos_delete_web_filtering_profile` | Delete a web filtering profile |
| `sophos_clone_web_filtering_profile` | Clone a web filtering profile |
| `sophos_get_web_filtering_metadata` | Get categories, groups, and presets |
| `sophos_list_site_lists` | List site lists |
| `sophos_get_site_list` | Get a site list |
| `sophos_create_site_list` | Create a site list |
| `sophos_update_site_list` | Update a site list (keeps what you leave out) |
| `sophos_delete_site_list` | Delete a site list |
| `sophos_clone_site_list` | Clone a site list |
| `sophos_list_sites` | List the sites in a site list |
| `sophos_add_site` | Add a site to a site list |
| `sophos_delete_site` | Delete a site from a site list |

### Switch Management (3 tools)

| Tool | Description |
|------|-------------|
| `sophos_get_switch_mac_filtering` | Get global switch MAC filtering settings |
| `sophos_update_switch_mac_filtering` | Replace the switch MAC filtering address list |
| `sophos_list_switch_tasks` | List switch configuration tasks |

### Accounts / Access Tokens (4 tools)

| Tool | Description |
|------|-------------|
| `sophos_list_access_tokens` | List repository access tokens |
| `sophos_create_access_token` | Create a repository access token (Sophos Linux Sensor) |
| `sophos_update_access_token` | Update a token's label or expiry |
| `sophos_revoke_access_token` | Revoke a token |

### Business Automation (4 tools)

Distributor-scoped: requires distributor-entitled credentials and an
X-Distributor-ID.

| Tool | Description |
|------|-------------|
| `sophos_list_ba_quotes` | List distributor quotes (new, amendment, renewal) |
| `sophos_get_ba_quote` | Get a quote by proposal number |
| `sophos_get_ba_partner_levels` | Partner program levels for a billing sub-region |
| `sophos_get_ba_pricing` | Price a set of product lines for a reseller |

### Tenant context

For **partner/org** callers, every tenant-scoped tool requires a `tenant_id` parameter. Use `sophos_list_tenants` first to discover available tenant IDs.

For **tenant-level** callers, `tenant_id` is optional and defaults to the authenticated tenant.


## Architecture

```
POST /mcp
    |
    v
src/worker.ts: route, CORS, access control (bearer token or S2S, or gateway headers)
    |
    v
src/session.ts: per-request Session, credentials -> per-credential cached state
    |
    v
OAuth2 token -> /whoami/v1 (partner | organization | tenant) -> tenant list {tenantId -> apiHost}
    |
    v
Per tool call: resolve tenant -> regional API host -> execute request
Per sophos_fusion_* call: resolve tenant -> POST api.taegis.sophos.com/graphql -> inspect data and errors
```

- `src/worker.ts`: the entry point. Routing, CORS, access control, and the only `export default`.
- `src/mcp.ts`: the MCP protocol, both the 2025-era JSON-RPC flow and the 2026-07-28 flow.
- `src/session.ts`: the per-request `Session`, the per-credential shared state (plain data only), and tool registration. A request never awaits a promise another request created.
- `src/tools/registry.ts`: `ToolRegistry` with `registerTool`, `tools/list`, argument validation and the write gate.
- `src/schema.ts`: a dependency-free, zod-shaped schema builder that produces JSON Schema for `tools/list` and validates arguments.
- `src/config/config.ts`, `src/auth/token-manager.ts`: configuration and the OAuth2 token lifecycle.
- `src/client/*`: the REST and GraphQL clients (retries, path safety, the GraphQL 200 rule) and the tenant resolver.
- `src/fusion/*`: GraphQL documents, case reference data, the QL builder, formatting and the migration guard.

### Key decisions

- **Conditional tool listing**: Only tools valid for the caller type are exposed to the LLM
- **Explicit tenant context**: Partner/org callers must specify `tenant_id` to prevent cross-tenant accidents
- **Stateless**: Each MCP request builds a fresh session; only plain data is cached across requests, per credential
- **Read-only by default**: write tools are off until `ALLOW_WRITES=true`

## Project Structure

```
wrangler.json                    # Worker name, vars, observability
tsconfig.json
package.json
.dev.vars.example                # Local secrets and vars for npm run dev
.github/workflows/ci.yml
docs/screenshots/
schemas/fusion/                  # The five Fusion GraphQL schemas, as downloaded
scripts/fusion-smoke.mjs         # Live check over MCP HTTP
src/
├── worker.ts                    # Entry: routing, CORS, access control
├── mcp.ts                       # MCP protocol (both versions)
├── session.ts                   # Per-request session, shared per-credential state, tool registration
├── schema.ts                    # Dependency-free schema builder (JSON Schema + validation)
├── log.ts                       # Logging
├── util.ts                      # Shared helpers
├── config/config.ts             # Config from Worker env
├── auth/token-manager.ts        # OAuth2 token lifecycle
├── client/
│   ├── sophos-client.ts         # REST client with region routing (Sophos Central)
│   ├── fusion-client.ts         # GraphQL client (Sophos Fusion), 200-with-errors handling, path-keyed retry
│   └── tenant-resolver.ts       # Whoami + tenant cache
├── fusion/
│   ├── queries/cases.ts         # Cases v2 GraphQL documents
│   ├── queries/detections.ts    # Detections v2 documents: the case summary lookup and the QL search
│   ├── case-reference-data.ts   # Per-tenant cache of case types, statuses, verdicts
│   ├── cases-ql.ts              # QL builder for the cases search
│   ├── format.ts                # Severity scales, timestamps, ID checks, mentions, tags, detection rows
│   ├── migration.ts             # Has this tenant moved to Fusion? Gates the Classic case and detection tools
│   └── types.ts                 # Fusion response types
├── tools/
│   ├── registry.ts              # ToolRegistry: registration, listing, validation, write gate
│   ├── helpers.ts               # Shared response formatting
│   ├── fusion-cases.ts          # Sophos Fusion cases (GraphQL)
│   ├── fusion-detections.ts     # Sophos Fusion detection search (GraphQL)
│   ├── tenants.ts               # Tenant listing (partner/org only)
│   ├── partner.ts               # Partner admin, roles, billing (partner/org only)
│   ├── accounts.ts              # Accounts and access tokens
│   ├── alerts.ts                # Alert list, get, acknowledge, search
│   ├── audit-events.ts          # Audit events
│   ├── business-automation.ts   # Billing and quote automation
│   ├── endpoints.ts             # Endpoint CRUD, scan, isolate, tamper, forensics
│   ├── endpoint-settings.ts     # Installer, web control, exploit mitigation, IPS, etc.
│   ├── endpoint-migrations.ts   # Migration jobs, software packages
│   ├── health.ts                # Account health, gap analysis
│   ├── directory.ts             # Users, user groups, group membership
│   ├── admin-management.ts      # Admin CRUD, roles, permission sets
│   ├── policies.ts              # Policy CRUD, clone, assignments
│   ├── groups.ts                # Endpoint group CRUD, membership
│   ├── exclusions.ts            # Scanning exclusions, allowed/blocked items
│   ├── cases.ts                 # Investigation cases, detections, MITRE
│   ├── detections.ts            # Detection queries (async)
│   ├── licensing.ts             # Licences
│   ├── siem.ts                  # SIEM events and alerts
│   ├── xdr.ts                   # XDR Data Lake queries (async)
│   ├── live-discover.ts         # Live Discover queries (async)
│   ├── firewall.ts              # Firewall CRUD, firmware, groups, threat feed, config import/export
│   ├── email.ts                 # Quarantine, mailboxes, message actions
│   ├── mobile.ts                # Mobile devices, groups, actions, policies
│   ├── dns-protection.ts        # DNS locations
│   ├── cloud-security.ts        # Cloud security profiles, assets
│   ├── switch.ts                # Switch management
│   ├── web-filtering.ts         # Web filtering profiles and rules
│   ├── wifi.ts                  # Wi-Fi MAC filtering
│   └── user-activity.ts         # User attestations
└── types/sophos.ts              # Sophos API response types
test/                            # node:test suites (*.test.ts), plus harness.ts, setup.ts and fakes
```

`schemas/fusion/` holds the five Fusion GraphQL schemas as downloaded from `https://developer.sophos.com/assets/graphql/<api>.graphql` on 21/09/2026, unmodified, for reference and for diffing when Sophos changes them.

## Security

- Credentials are Worker secrets (or, in gateway mode, per-request headers), never logged, and never written to disk
- `/mcp` access control is a bearer token (`MCP_AUTH_TOKEN`) or a signed `X-Gateway-S2S` header (`CONDUIT_S2S_SECRET`). One of them is required in `env` mode: without it `/mcp` returns 503. In gateway mode a request without its own credential headers is a 401 and never falls back to the secrets
- `ALLOW_WRITES` defaults to `false`: write tools are not listed and are refused. Previews are always read-only
- OAuth tokens are cached in memory per credential and refreshed before they expire
- `SOPHOS_FUSION_GRAPHQL_URL` must be `https` on a `sophos.com` host, since the bearer token goes to it; the Worker refuses to serve otherwise
- The REST client refuses a request path where an ID argument carries a `.` or `..` segment (encoded too), `?`, `#`, a backslash, an encoded `/` or a control character, so a crafted ID cannot redirect a call to another resource
- Pre-signed URLs (case file uploads, firewall backups and imports) never get the Sophos token. A backup `download_url` is a secret until it expires
- Write actions have `destructiveHint` annotations so clients can warn users
- Partner/org callers require explicit `tenant_id` on every call

## License

MIT
