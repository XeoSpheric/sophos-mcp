// Per-request wiring of the Sophos clients and the tool registry.
//
// State that outlives a request (the OAuth token, the caller identity, the
// tenant map, the Fusion case reference data) is plain data held per
// credential at module level. Every object that can hold a promise (token
// refresh, reference data fetch) is built per request: a Worker request must
// never await a promise another request created.

import { type Credentials, type TokenStore, TokenManager } from "./auth/token-manager.ts";
import { FusionClient } from "./client/fusion-client.ts";
import { SophosClient } from "./client/sophos-client.ts";
import { type TenancyStore, TenantResolver, newTenancyStore } from "./client/tenant-resolver.ts";
import { type CaseReferenceDataStore, CaseReferenceDataCache } from "./fusion/case-reference-data.ts";
import { FusionMigrationGuard } from "./fusion/migration.ts";
import { log } from "./log.ts";
import { type ToolResult, errorResult } from "./tools/helpers.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { type Obj, sha256Hex } from "./util.ts";

import { registerAccountsTools } from "./tools/accounts.ts";
import { registerAdminManagementTools } from "./tools/admin-management.ts";
import { registerAlertTools } from "./tools/alerts.ts";
import { registerAuditEventTools } from "./tools/audit-events.ts";
import { registerBusinessAutomationTools } from "./tools/business-automation.ts";
import { registerCaseTools } from "./tools/cases.ts";
import { registerCloudSecurityTools } from "./tools/cloud-security.ts";
import { registerDetectionTools } from "./tools/detections.ts";
import { registerDirectoryTools } from "./tools/directory.ts";
import { registerDnsProtectionTools } from "./tools/dns-protection.ts";
import { registerEmailTools } from "./tools/email.ts";
import { registerEndpointMigrationTools } from "./tools/endpoint-migrations.ts";
import { registerEndpointSettingsTools } from "./tools/endpoint-settings.ts";
import { registerEndpointTools } from "./tools/endpoints.ts";
import { registerExclusionTools } from "./tools/exclusions.ts";
import { registerFirewallTools } from "./tools/firewall.ts";
import { registerFusionCaseTools } from "./tools/fusion-cases.ts";
import { registerFusionDetectionTools } from "./tools/fusion-detections.ts";
import { registerGroupTools } from "./tools/groups.ts";
import { registerHealthTools } from "./tools/health.ts";
import { registerLicensingTools } from "./tools/licensing.ts";
import { registerLiveDiscoverTools } from "./tools/live-discover.ts";
import { registerMobileTools } from "./tools/mobile.ts";
import { registerPartnerTools } from "./tools/partner.ts";
import { registerPolicyTools } from "./tools/policies.ts";
import { registerSiemTools } from "./tools/siem.ts";
import { registerSwitchTools } from "./tools/switch.ts";
import { registerTenantTools } from "./tools/tenants.ts";
import { registerUserActivityTools } from "./tools/user-activity.ts";
import { registerWebFilteringTools } from "./tools/web-filtering.ts";
import { registerWifiTools } from "./tools/wifi.ts";
import { registerXdrTools } from "./tools/xdr.ts";

// ---------------------------------------------------------------------------
// Shared per-credential state (plain data only)
// ---------------------------------------------------------------------------

export interface SharedState {
  tokens: TokenStore;
  tenancy: TenancyStore;
  referenceData: CaseReferenceDataStore;
}

export function newSharedState(): SharedState {
  return { tokens: { accessToken: null, expiresAt: 0 }, tenancy: newTenancyStore(), referenceData: new Map() };
}

/** Gateway mode can bring many credentials; the oldest state is dropped past this. */
const MAX_STATES = 32;
const states = new Map<string, SharedState>();

/**
 * State for a credential, keyed on a hash of id and secret together: keying
 * on the id alone would let a gateway caller with a valid id and a wrong
 * secret reuse someone else's cached token.
 */
async function sharedState(creds: Credentials): Promise<SharedState> {
  const key = await sha256Hex(`${creds.clientId}\n${creds.clientSecret}`);
  let state = states.get(key);
  if (state) {
    states.delete(key);
  } else {
    state = newSharedState();
    while (states.size >= MAX_STATES) states.delete(states.keys().next().value!);
  }
  states.set(key, state);
  return state;
}

/** Drop every cached token, identity and tenant map (tests). */
export function resetSharedState(): void {
  states.clear();
}

// ---------------------------------------------------------------------------
// Services and tool registration
// ---------------------------------------------------------------------------

export interface Services {
  tokenManager: TokenManager;
  tenantResolver: TenantResolver;
  sophosClient: SophosClient;
  fusionClient: FusionClient;
  caseReferenceData: CaseReferenceDataCache;
  migrationGuard: FusionMigrationGuard;
}

export function buildServices(creds: Credentials, state: SharedState = newSharedState()): Services {
  const tokenManager = new TokenManager(creds, state.tokens);
  const tenantResolver = new TenantResolver(tokenManager, state.tenancy);
  // REST for Sophos Central, GraphQL for Sophos Fusion
  const sophosClient = new SophosClient(tokenManager, tenantResolver);
  const fusionClient = new FusionClient(tokenManager);
  const caseReferenceData = new CaseReferenceDataCache(fusionClient, undefined, state.referenceData);
  // Classic case and detection tools refuse a tenant that has moved to Fusion
  const migrationGuard = new FusionMigrationGuard(caseReferenceData);
  return { tokenManager, tenantResolver, sophosClient, fusionClient, caseReferenceData, migrationGuard };
}

/**
 * Register every tool. The partner/org tools are registered unless the
 * caller is known to be a single tenant.
 */
export function registerAllTools(registry: ToolRegistry, s: Services): ToolRegistry {
  const { sophosClient, tenantResolver, fusionClient, caseReferenceData, migrationGuard } = s;

  // Partner/org-only tools
  if (tenantResolver.isMultiTenant()) {
    registerTenantTools(registry, tenantResolver);
    registerPartnerTools(registry, sophosClient, tenantResolver);
  }

  // Tenant-scoped SOC monitoring
  registerAlertTools(registry, sophosClient, tenantResolver);
  registerEndpointTools(registry, sophosClient, tenantResolver);
  registerHealthTools(registry, sophosClient, tenantResolver);
  registerDirectoryTools(registry, sophosClient, tenantResolver);

  // Admin automation
  registerPolicyTools(registry, sophosClient, tenantResolver);
  registerGroupTools(registry, sophosClient, tenantResolver);
  registerExclusionTools(registry, sophosClient, tenantResolver);

  // Investigation
  registerCaseTools(registry, sophosClient, tenantResolver, migrationGuard);
  registerDetectionTools(registry, sophosClient, tenantResolver, migrationGuard);
  registerSiemTools(registry, sophosClient, tenantResolver);
  registerXdrTools(registry, sophosClient, tenantResolver);
  registerLiveDiscoverTools(registry, sophosClient, tenantResolver);

  // Endpoint migrations, software packages and settings
  registerEndpointMigrationTools(registry, sophosClient, tenantResolver);
  registerEndpointSettingsTools(registry, sophosClient, tenantResolver);

  // Firewall, admin management, email
  registerFirewallTools(registry, sophosClient, tenantResolver);
  registerAdminManagementTools(registry, sophosClient, tenantResolver);
  registerEmailTools(registry, sophosClient, tenantResolver);

  // DNS, cloud security, Wi-Fi, user activity, mobile
  registerDnsProtectionTools(registry, sophosClient, tenantResolver);
  registerCloudSecurityTools(registry, sophosClient, tenantResolver);
  registerWifiTools(registry, sophosClient, tenantResolver);
  registerUserActivityTools(registry, sophosClient, tenantResolver);
  registerMobileTools(registry, sophosClient, tenantResolver);

  // Audit events, licensing, web filtering, switch, accounts, business automation
  registerAuditEventTools(registry, sophosClient, tenantResolver);
  registerLicensingTools(registry, sophosClient, tenantResolver);
  registerWebFilteringTools(registry, sophosClient, tenantResolver);
  registerSwitchTools(registry, sophosClient, tenantResolver);
  registerAccountsTools(registry, sophosClient, tenantResolver);
  registerBusinessAutomationTools(registry, sophosClient, tenantResolver);

  // Fusion: GraphQL APIs on api.taegis.sophos.com, beside the Classic REST tools
  registerFusionCaseTools(registry, fusionClient, tenantResolver, caseReferenceData);
  registerFusionDetectionTools(registry, fusionClient, tenantResolver);

  return registry;
}

// ---------------------------------------------------------------------------
// Session: one per request
// ---------------------------------------------------------------------------

const MISSING_CREDENTIALS =
  "Missing Sophos credentials: set the SOPHOS_CLIENT_ID and SOPHOS_CLIENT_SECRET secrets (or, in gateway mode, send X-Sophos-Client-Id and X-Sophos-Client-Secret).";

interface Built {
  registry: ToolRegistry;
  /** Why tool calls cannot run (no credentials, identity lookup failed). */
  unavailable?: string;
}

export class Session {
  readonly #creds: Credentials | undefined;
  readonly allowWrites: boolean;
  #built: Promise<Built> | undefined;

  constructor(creds: Credentials | undefined, allowWrites: boolean) {
    this.#creds = creds;
    this.allowWrites = allowWrites;
  }

  get hasCredentials(): boolean {
    return this.#creds !== undefined;
  }

  /**
   * The registry for this request, built once. The caller identity decides
   * whether the partner/org tools are registered, so it is resolved first
   * (cached per credential after the first success). Without credentials, or
   * when whoami fails, every tool is listed and calls return the reason.
   */
  #build(): Promise<Built> {
    this.#built ??= (async (): Promise<Built> => {
      if (!this.#creds) {
        return { registry: registerAllTools(new ToolRegistry(), buildServices({ clientId: "", clientSecret: "" })), unavailable: MISSING_CREDENTIALS };
      }
      const services = buildServices(this.#creds, await sharedState(this.#creds));
      let unavailable: string | undefined;
      try {
        await services.tenantResolver.init();
      } catch (e) {
        unavailable = `Sophos identity lookup failed: ${e instanceof Error ? e.message : String(e)}`;
        log.warn(unavailable);
      }
      return { registry: registerAllTools(new ToolRegistry(), services), unavailable };
    })();
    return this.#built;
  }

  async listTools(): Promise<Obj[]> {
    const { registry } = await this.#build();
    return registry.list(this.allowWrites);
  }

  async callTool(name: string, args: unknown): Promise<ToolResult> {
    const { registry, unavailable } = await this.#build();
    if (unavailable && registry.has(name)) return errorResult(new Error(unavailable));
    return registry.call(name, args, this.allowWrites);
  }
}
