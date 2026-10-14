/**
 * Manages OAuth2 client credentials authentication with Sophos Central.
 * Handles token acquisition and transparent refresh before expiry.
 *
 * The token itself lives in a TokenStore, plain data shared by every request
 * in the isolate that uses the same credentials. The refresh promise is per
 * TokenManager, and a TokenManager is per request: a Worker request must never
 * await a promise another request created.
 */

import { SOPHOS_AUTH_URL } from "../config/config.ts";
import { log } from "../log.ts";
import type { SophosTokenResponse } from "../types/sophos.ts";

export interface Credentials {
  clientId: string;
  clientSecret: string;
}

export interface TokenStore {
  accessToken: string | null;
  expiresAt: number;
}

export class TokenManager {
  readonly #creds: Credentials;
  readonly #store: TokenStore;
  #refreshPromise: Promise<string> | null = null;

  constructor(creds: Credentials, store: TokenStore = { accessToken: null, expiresAt: 0 }) {
    this.#creds = creds;
    this.#store = store;
  }

  /**
   * Returns a valid access token, refreshing if needed.
   * Deduplicates concurrent refresh calls within the request.
   */
  async getToken(): Promise<string> {
    // If token is valid for at least 60 more seconds, return it
    if (this.#store.accessToken && Date.now() < this.#store.expiresAt - 60_000) {
      return this.#store.accessToken;
    }

    if (this.#refreshPromise) {
      return this.#refreshPromise;
    }

    this.#refreshPromise = this.#fetchToken();
    try {
      return await this.#refreshPromise;
    } finally {
      this.#refreshPromise = null;
    }
  }

  async #fetchToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.#creds.clientId,
      client_secret: this.#creds.clientSecret,
      scope: "token",
    });

    const response = await fetch(SOPHOS_AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Sophos auth failed (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as SophosTokenResponse;

    if (data.errorCode && data.errorCode !== "success") {
      throw new Error(`Sophos auth error: ${data.errorCode} - ${data.message}`);
    }

    this.#store.accessToken = data.access_token;
    this.#store.expiresAt = Date.now() + data.expires_in * 1000;

    log.info(`Sophos token acquired, expires in ${data.expires_in}s`);
    return data.access_token;
  }
}
