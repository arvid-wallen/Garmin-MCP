import type { GarminConfig } from '../config.js';

/**
 * Minimal client for the Garmin Connect Personal API.
 *
 * Auth model (from Garmin's docs and reference client): the long-lived
 * Personal API key is exchanged for a ~24h JWT bearer token at
 * POST /personalapitoken-service/personal-api/personal-api-key/token with
 * `Authorization: ApiKey <key>`. There are no refresh tokens; a new token is
 * obtained by repeating the exchange.
 */

export const TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';

/** Refresh the bearer token when less than this much lifetime remains. */
const REFRESH_WINDOW_MS = 60 * 60 * 1000;
const MAX_RETRIES = 2;
const MAX_RETRY_AFTER_MS = 10_000;

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type QueryValue = string | number | boolean | undefined | null;
export type Query = Record<string, QueryValue>;

export class GarminApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    const snippet = body.trim().slice(0, 500);
    super(`Garmin API ${status} for ${path}${snippet ? `: ${snippet}` : ''}`);
  }
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

export function jwtExpiryMs(token: string): number | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof json.exp === 'number' ? json.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function buildUrl(baseUrl: string, path: string, query?: Query): string {
  const url = new URL(baseUrl + path);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class GarminClient {
  private token?: CachedToken;
  private tokenPromise?: Promise<CachedToken>;
  private readonly fetchImpl: FetchLike;

  constructor(
    readonly config: GarminConfig,
    fetchImpl: FetchLike = globalThis.fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.fetchImpl = fetchImpl;
  }

  /** Return a valid bearer token, exchanging the API key when needed. Concurrent callers share one exchange. */
  async getToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.token && this.token.expiresAt - this.now() > REFRESH_WINDOW_MS) {
      return this.token.value;
    }
    if (!this.tokenPromise) {
      this.tokenPromise = this.exchangeKey().finally(() => {
        this.tokenPromise = undefined;
      });
    }
    this.token = await this.tokenPromise;
    return this.token.value;
  }

  private async exchangeKey(): Promise<CachedToken> {
    const response = await this.fetchWithTimeout(this.config.baseUrl + TOKEN_PATH, {
      method: 'POST',
      headers: { Accept: '*/*', Authorization: `ApiKey ${this.config.apiKey}` },
    });
    const text = await response.text();
    if (!response.ok) {
      // Never echo request headers; the body is Garmin's error message only.
      const hint =
        response.status === 401 || response.status === 403
          ? 'Personal API key rejected (invalid, expired or deleted). Create a new key at https://connect.garmin.com/app/settings/personalApiToken and update GARMIN_PERSONAL_API_KEY.'
          : text;
      throw new GarminApiError(response.status, TOKEN_PATH, hint);
    }
    let value = text.trim();
    if (value.startsWith('{')) {
      const json = JSON.parse(value) as { access_token?: string; accessToken?: string; token?: string };
      value = json.access_token ?? json.accessToken ?? json.token ?? '';
    }
    if (!value) throw new GarminApiError(response.status, TOKEN_PATH, 'Token endpoint returned an empty token');
    const expiresAt = jwtExpiryMs(value) ?? this.now() + 23 * 60 * 60 * 1000;
    return { value, expiresAt };
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const signal = AbortSignal.timeout(this.config.timeoutMs);
    return this.fetchImpl(url, { ...init, signal });
  }

  /**
   * GET with auth, one forced token refresh on 401, and bounded retries on
   * 429/5xx. Returns the raw response (status is always 2xx).
   */
  async request(path: string, query?: Query, accept = 'application/json'): Promise<Response> {
    const url = buildUrl(this.config.baseUrl, path, query);
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken();
      const response = await this.fetchWithTimeout(url, {
        method: 'GET',
        headers: { Accept: accept, Authorization: `Bearer ${token}` },
      });
      if (response.ok) return response;

      if (response.status === 401 && !refreshed) {
        await response.body?.cancel();
        refreshed = true;
        await this.getToken(true);
        continue;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
        await response.body?.cancel();
        const retryAfter = Number(response.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
        await sleep(Math.min(delay, MAX_RETRY_AFTER_MS));
        continue;
      }
      throw new GarminApiError(response.status, path, await response.text());
    }
  }

  /** GET and decode JSON. An empty body (e.g. 204, or no data for the day) returns null. */
  async get<T = unknown>(path: string, query?: Query): Promise<T | null> {
    const response = await this.request(path, query);
    const text = await response.text();
    if (!text.trim()) return null;
    return JSON.parse(text) as T;
  }

  /** GET binary content (activity file downloads). */
  async getBytes(path: string): Promise<{ bytes: Uint8Array; contentType: string | null; fileName?: string }> {
    const response = await this.request(
      path,
      undefined,
      'application/zip, application/x-zip-compressed, application/octet-stream',
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    const disposition = response.headers.get('content-disposition') ?? '';
    const fileName = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
    return { bytes, contentType: response.headers.get('content-type'), fileName };
  }
}
