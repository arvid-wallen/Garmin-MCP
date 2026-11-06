import type { FetchLike } from '../src/garmin/client.js';
import type { GarminConfig, HttpConfig } from '../src/config.js';

export function fakeJwt(expSecondsFromNow = 24 * 3600, extra: Record<string, unknown> = {}): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow, ...extra })}.sig`;
}

export interface Call {
  method: string;
  url: URL;
  headers: Headers;
}

type Handler = (url: URL, call: Call) => Response | Promise<Response>;

/** A fake Garmin API: token exchange plus path-pattern routes. */
export function fakeGarmin(routes: Array<[RegExp, Handler]>, opts: { token?: () => string } = {}) {
  const calls: Call[] = [];
  let tokenCount = 0;
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const call = { method: init?.method ?? 'GET', url, headers: new Headers(init?.headers) };
    calls.push(call);
    if (url.pathname.endsWith('/personal-api-key/token')) {
      if (call.headers.get('authorization') !== 'ApiKey test-key') return new Response('bad key', { status: 401 });
      tokenCount++;
      return new Response(opts.token ? opts.token() : fakeJwt(), { status: 200 });
    }
    for (const [pattern, handler] of routes) {
      if (pattern.test(url.pathname)) return handler(url, call);
    }
    return new Response('not found', { status: 404 });
  };
  return { fetch: fetchImpl, calls, tokenCount: () => tokenCount };
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const garminConfig: GarminConfig = {
  apiKey: 'test-key',
  baseUrl: 'https://garmin.test',
  timeoutMs: 5000,
  timeZone: 'Europe/Stockholm',
};

export const httpConfig: HttpConfig = {
  garmin: garminConfig,
  auth: {
    secret: 'x'.repeat(48),
    ownerPassword: 'correct horse battery',
    tokenVersion: '1',
    accessTokenTtlSeconds: 3600,
    refreshTokenTtlSeconds: 86400,
    extraRedirectUris: [],
  },
  publicUrl: 'https://mcp.example.com',
};
