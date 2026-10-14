/**
 * Discovers the caller's identity type via /whoami/v1 and resolves
 * tenant IDs to their regional API hosts. Caches the mapping.
 *
 * The identity and tenant map live in a TenancyStore, plain data shared by
 * every request in the isolate that uses the same credentials. A
 * TenantResolver is per request and holds no promise another request awaits.
 */

import { SOPHOS_GLOBAL_API } from "../config/config.ts";
import { log } from "../log.ts";
import type { TokenManager } from "../auth/token-manager.ts";
import type {
  SophosIdType,
  SophosWhoamiResponse,
  SophosTenant,
  SophosTenantPage,
} from "../types/sophos.ts";

export interface TenantInfo {
  id: string;
  name: string;
  apiHost: string;
  dataRegion: string;
  dataGeography: string;
}

export interface CallerIdentity {
  id: string;
  idType: SophosIdType;
  apiHosts: {
    global: string;
    dataRegion?: string;
  };
}

export interface TenancyStore {
  identity: CallerIdentity | null;
  tenants: Map<string, TenantInfo>;
  /** Date.now() of the last complete tenant list load; 0 when never loaded. */
  tenantsLoadedAt: number;
}

export function newTenancyStore(): TenancyStore {
  return { identity: null, tenants: new Map(), tenantsLoadedAt: 0 };
}

/** A partner or organization tenant list is reloaded after this long. */
const TENANT_LIST_TTL_MS = 15 * 60_000;

export class TenantResolver {
  readonly #tokenManager: TokenManager;
  readonly #store: TenancyStore;

  constructor(tokenManager: TokenManager, store: TenancyStore = newTenancyStore()) {
    this.#tokenManager = tokenManager;
    this.#store = store;
  }

  private get tenantCache(): Map<string, TenantInfo> {
    return this.#store.tenants;
  }

  private get tenantsLoaded(): boolean {
    const identity = this.#store.identity;
    if (identity?.idType === "tenant") return this.#store.tenantsLoadedAt > 0;
    return this.#store.tenantsLoadedAt > 0 && Date.now() - this.#store.tenantsLoadedAt < TENANT_LIST_TTL_MS;
  }

  /**
   * Initialise: calls /whoami/v1 and discovers the caller identity. The
   * identity never changes for a credential, so it is fetched once per isolate.
   */
  async init(): Promise<CallerIdentity> {
    if (this.#store.identity) return this.#store.identity;
    const token = await this.#tokenManager.getToken();
    const response = await fetch(`${SOPHOS_GLOBAL_API}/whoami/v1`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Whoami failed (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as SophosWhoamiResponse;
    const identity: CallerIdentity = {
      id: data.id,
      idType: data.idType,
      apiHosts: data.apiHosts,
    };

    log.info(`Sophos identity: ${data.idType} (${data.id})`);

    // For tenant-level callers, the data region host is returned directly
    if (data.idType === "tenant" && data.apiHosts.dataRegion) {
      this.tenantCache.set(data.id, {
        id: data.id,
        name: "self",
        apiHost: data.apiHosts.dataRegion,
        dataRegion: "self",
        dataGeography: "unknown",
      });
      this.#store.tenantsLoadedAt = Date.now();
    }

    this.#store.identity = identity;
    return identity;
  }

  getIdentity(): CallerIdentity {
    if (!this.#store.identity) {
      throw new Error("TenantResolver not initialised. Call init() first.");
    }
    return this.#store.identity;
  }

  /**
   * True for partner/organization callers, and while the identity is unknown
   * (no credentials, or whoami failed), so every tool is listed.
   */
  isMultiTenant(): boolean {
    return this.#store.identity?.idType !== "tenant";
  }

  /**
   * Returns the ID type header name needed for partner/org API calls.
   */
  getIdHeader(): { name: string; value: string } {
    const identity = this.getIdentity();
    switch (identity.idType) {
      case "partner":
        return { name: "X-Partner-ID", value: identity.id };
      case "organization":
        return { name: "X-Organization-ID", value: identity.id };
      case "tenant":
        return { name: "X-Tenant-ID", value: identity.id };
    }
  }

  /**
   * Loads all tenants for partner/org callers. Paginates through all pages.
   */
  async loadTenants(): Promise<TenantInfo[]> {
    const identity = this.getIdentity();

    if (identity.idType === "tenant") {
      return Array.from(this.tenantCache.values());
    }

    if (this.tenantsLoaded) {
      return Array.from(this.tenantCache.values());
    }

    const apiPath =
      identity.idType === "partner"
        ? "/partner/v1/tenants"
        : "/organization/v1/tenants";

    const idHeader = this.getIdHeader();
    let page = 1;
    let totalPages = 1;

    const loaded = new Map<string, TenantInfo>();
    while (page <= totalPages) {
      const token = await this.#tokenManager.getToken();
      const url = new URL(`${SOPHOS_GLOBAL_API}${apiPath}`);
      url.searchParams.set("page", String(page));
      if (page === 1) {
        url.searchParams.set("pageTotal", "true");
      }

      const response = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          [idHeader.name]: idHeader.value,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `List tenants failed (${response.status}): ${errorText}`
        );
      }

      const data = (await response.json()) as SophosTenantPage;

      if (page === 1 && data.pages.total) {
        totalPages = data.pages.total;
      }

      for (const tenant of data.items) {
        loaded.set(tenant.id, {
          id: tenant.id,
          name: tenant.name,
          apiHost: tenant.apiHost,
          dataRegion: tenant.dataRegion,
          dataGeography: tenant.dataGeography,
        });
      }

      page++;
    }

    // Swap in the complete list at once, so a tenant removed since the last
    // load stops resolving and a failed load leaves the old list in place.
    this.#store.tenants = loaded;
    this.#store.tenantsLoadedAt = Date.now();
    log.info(`Loaded ${loaded.size} Sophos tenants`);
    return Array.from(loaded.values());
  }

  /**
   * Resolves a tenant ID to its API host. Loads tenants if not cached.
   */
  async resolveApiHost(tenantId: string): Promise<string> {
    if (this.tenantCache.has(tenantId)) {
      return this.tenantCache.get(tenantId)!.apiHost;
    }

    // Load (or reload a stale) tenant list
    if (!this.tenantsLoaded) {
      await this.loadTenants();
    }

    const info = this.tenantCache.get(tenantId);
    if (!info) {
      throw new Error(
        `Tenant ${tenantId} not found. Use sophos_list_tenants to see available tenants.`
      );
    }
    return info.apiHost;
  }

  /**
   * Returns the tenant ID to use. For single-tenant callers, returns the
   * identity ID. For partner/org callers, requires an explicit tenant ID.
   */
  resolveTenantId(providedTenantId?: string): string {
    const identity = this.getIdentity();

    if (identity.idType === "tenant") {
      return providedTenantId || identity.id;
    }

    if (!providedTenantId) {
      throw new Error(
        "tenant_id is required for partner/organization callers. " +
          "Use sophos_list_tenants to find available tenant IDs."
      );
    }

    return providedTenantId;
  }

  /**
   * Returns all cached tenants (possibly empty or stale; loadTenants() refreshes).
   */
  getCachedTenants(): TenantInfo[] {
    return Array.from(this.tenantCache.values());
  }
}
