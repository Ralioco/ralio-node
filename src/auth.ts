/**
 * Access-token lifecycle for the machine path.
 *
 * A {@link TokenManager} mints tokens via the `private_key_jwt` client
 * assertion, caches the access token until shortly before expiry, and rotates
 * the refresh token. All token mutations are serialised behind a lock:
 *
 * > Presenting a previously-rotated refresh token is treated as a replay
 * > attack and revokes the whole chain.
 *
 * so two concurrent callers must never race a refresh.
 */

import { CLIENT_ASSERTION_TYPE, signClientAssertion, type CryptoKey } from "./crypto.js";
import { raiseForResponse } from "./errors.js";

export interface TokenManagerOptions {
  clientId: string;
  privateKey: CryptoKey;
  kid: string;
  tokenUrl: string;
  scopes?: string[];
  /** Current refresh token for this SDK instance, if already known. */
  refreshToken?: string | null;
  /** Persist refresh-token rotation for this SDK instance. */
  saveRefreshToken?: (refreshToken: string | null) => Promise<void>;
  /** Refresh this many seconds before the token actually expires. */
  refreshLeewaySeconds?: number;
}

export class TokenManager {
  private readonly clientId: string;
  private readonly privateKey: CryptoKey;
  private readonly kid: string;
  private readonly tokenUrl: string;
  private readonly scopes?: string[];
  private readonly leewayMs: number;
  private readonly saveRefreshToken?: (refreshToken: string | null) => Promise<void>;

  private accessTokenValue: string | null = null;
  private refreshTokenValue: string | null = null;
  private expiresAtMs = 0;

  // Serialises all token mutations: each exclusive section runs after the
  // previous one settles, so two callers never mint/refresh concurrently.
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: TokenManagerOptions) {
    this.clientId = opts.clientId;
    this.privateKey = opts.privateKey;
    this.kid = opts.kid;
    this.tokenUrl = opts.tokenUrl;
    this.scopes = opts.scopes;
    this.refreshTokenValue = opts.refreshToken ?? null;
    this.saveRefreshToken = opts.saveRefreshToken;
    this.leewayMs = (opts.refreshLeewaySeconds ?? 300) * 1000;
  }

  /** Return a valid access token, minting or refreshing as needed. */
  async accessToken(): Promise<string> {
    if (this.accessTokenValue && Date.now() < this.expiresAtMs - this.leewayMs) {
      return this.accessTokenValue;
    }
    return this.withLock(async () => {
      // Re-check inside the lock: a concurrent caller may have just refreshed.
      if (this.accessTokenValue && Date.now() < this.expiresAtMs - this.leewayMs) {
        return this.accessTokenValue;
      }
      return this.obtain();
    });
  }

  /** Discard the cached token and obtain a fresh one. Used after a 401. */
  async forceRefresh(): Promise<string> {
    return this.withLock(async () => {
      this.accessTokenValue = null;
      return this.obtain();
    });
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    // Keep the chain alive regardless of success/failure of this section.
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async obtain(): Promise<string> {
    if (this.refreshTokenValue) {
      try {
        return await this.refresh();
      } catch {
        // Refresh chains can be revoked or expired; fall back to a fresh
        // client-assertion mint, which always works while the binding is active.
        this.refreshTokenValue = null;
        await this.persistRefreshToken(null);
      }
    }
    return this.mint();
  }

  private async mint(): Promise<string> {
    const assertion = await signClientAssertion(this.privateKey, {
      clientId: this.clientId,
      audience: this.tokenUrl,
      kid: this.kid,
    });
    const data: Record<string, string> = {
      grant_type: "client_credentials",
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: assertion,
    };
    if (this.scopes && this.scopes.length > 0) {
      data.scope = this.scopes.join(" ");
    }
    return this.exchange(data);
  }

  private async refresh(): Promise<string> {
    if (!this.refreshTokenValue) throw new Error("no refresh token");
    return this.exchange({
      grant_type: "refresh_token",
      refresh_token: this.refreshTokenValue,
      client_id: this.clientId,
    });
  }

  private async exchange(data: Record<string, string>): Promise<string> {
    const response = await fetch(this.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(data).toString(),
    });
    await raiseForResponse(response);
    const body = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };
    this.accessTokenValue = body.access_token;
    if (body.refresh_token && body.refresh_token !== this.refreshTokenValue) {
      this.refreshTokenValue = body.refresh_token;
      await this.persistRefreshToken(this.refreshTokenValue);
    }
    this.expiresAtMs = Date.now() + (body.expires_in ?? 1800) * 1000;
    return this.accessTokenValue;
  }

  private async persistRefreshToken(refreshToken: string | null): Promise<void> {
    if (this.saveRefreshToken) await this.saveRefreshToken(refreshToken);
  }
}
