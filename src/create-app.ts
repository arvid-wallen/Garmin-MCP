import { createMcpHandler, OAuthError, requireBearerAuth, type AuthInfo } from '@modelcontextprotocol/server';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';

import type { HttpConfig } from './config.js';
import { GarminClient, type FetchLike } from './garmin/client.js';
import { ClientError, isRedirectAllowed, redirectMatches, resolveClient, type ResolvedClient } from './oauth/clients.js';
import { consentPage, errorPage } from './oauth/page.js';
import { pkceS256, safeEqual, SCOPE, TokenService } from './oauth/tokens.js';
import { createGarminServer, SERVER_NAME, SERVER_VERSION } from './tools/index.js';

export const MCP_PATH = '/mcp';

export interface AppDeps {
  /** fetch used for Garmin API calls. */
  garminFetch?: FetchLike;
  /** fetch used for Client ID Metadata Document lookups. */
  cimdFetch?: typeof fetch;
}

// ---- Login throttling ------------------------------------------------------------

const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_IP = 10;
const MAX_FAILURES_GLOBAL = 50;

class LoginThrottle {
  private readonly perIp = new Map<string, number[]>();
  private global: number[] = [];

  private prune(list: number[]): number[] {
    const cutoff = Date.now() - FAILURE_WINDOW_MS;
    return list.filter((t) => t > cutoff);
  }

  blocked(ip: string): boolean {
    this.global = this.prune(this.global);
    const mine = this.prune(this.perIp.get(ip) ?? []);
    this.perIp.set(ip, mine);
    return mine.length >= MAX_FAILURES_PER_IP || this.global.length >= MAX_FAILURES_GLOBAL;
  }

  fail(ip: string) {
    this.global.push(Date.now());
    this.perIp.set(ip, [...(this.perIp.get(ip) ?? []), Date.now()]);
  }
}

// ---- Helpers ---------------------------------------------------------------------

function baseUrlFor(c: Context, configured?: string): string {
  if (configured) return configured;
  const url = new URL(c.req.url);
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.replace(':', '');
  const host = c.req.header('x-forwarded-host')?.split(',')[0]?.trim() || c.req.header('host') || url.host;
  return `${proto}://${host}`;
}

function clientIp(c: Context): string {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    c.req.header('x-real-ip') ||
    c.req.header('cf-connecting-ip') ||
    'unknown'
  );
}

function sameResource(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/#.*$/, '').replace(/\/$/, '');
  return norm(a) === norm(b);
}

function oauthError(c: Context, error: string, description: string, status: 400 | 401 = 400) {
  c.header('Cache-Control', 'no-store');
  return c.json({ error, error_description: description }, status);
}

function htmlHeaders(c: Context, formActionOrigin?: string) {
  c.header('Cache-Control', 'no-store');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header(
    'Content-Security-Policy',
    `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${formActionOrigin ? ` ${formActionOrigin}` : ''}; frame-ancestors 'none'; base-uri 'none'`,
  );
}

async function formOrJson(c: Context): Promise<Record<string, string>> {
  const type = c.req.header('content-type') ?? '';
  if (type.includes('application/json')) {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)]));
  }
  const body = await c.req.parseBody();
  return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, typeof v === 'string' ? v : '']));
}

const AUTHORIZE_PARAMS = ['response_type', 'client_id', 'redirect_uri', 'state', 'scope', 'code_challenge', 'code_challenge_method', 'resource'] as const;

// ---- App -------------------------------------------------------------------------

export function createApp(config: HttpConfig, deps: AppDeps = {}) {
  const tokens = new TokenService(config.auth);
  const throttle = new LoginThrottle();
  const garmin = new GarminClient(config.garmin, deps.garminFetch);
  const cimdFetch = deps.cimdFetch ?? globalThis.fetch;
  // One Garmin client per instance, so its bearer token is reused across requests.
  const mcp = createMcpHandler(() => createGarminServer(garmin));

  const app = new Hono();

  app.use(
    '*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type', 'Mcp-Session-Id', 'Mcp-Protocol-Version', 'Last-Event-ID', 'Accept'],
      exposeHeaders: ['WWW-Authenticate', 'Mcp-Session-Id', 'Mcp-Protocol-Version'],
      maxAge: 86400,
    }),
  );

  app.get('/', (c) =>
    c.json({
      name: SERVER_NAME,
      version: SERVER_VERSION,
      mcp_endpoint: `${baseUrlFor(c, config.publicUrl)}${MCP_PATH}`,
      auth: 'OAuth 2.1 (authorization code + PKCE). Add the mcp_endpoint URL as a custom connector in Claude.',
    }),
  );
  app.get('/health', (c) => c.json({ ok: true }));

  // ---- Discovery ----------------------------------------------------------------

  const protectedResource = (c: Context) => {
    const base = baseUrlFor(c, config.publicUrl);
    return c.json({
      resource: `${base}${MCP_PATH}`,
      authorization_servers: [base],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'Garmin Connect (Personal API)',
    });
  };
  app.get('/.well-known/oauth-protected-resource', protectedResource);
  app.get(`/.well-known/oauth-protected-resource${MCP_PATH}`, protectedResource);

  const authServerMetadata = (c: Context) => {
    const base = baseUrlFor(c, config.publicUrl);
    return c.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      scopes_supported: [SCOPE],
    });
  };
  app.get('/.well-known/oauth-authorization-server', authServerMetadata);
  app.get(`/.well-known/oauth-authorization-server${MCP_PATH}`, authServerMetadata);
  app.get('/.well-known/openid-configuration', authServerMetadata);

  // ---- Dynamic client registration (RFC 7591) -------------------------------------

  app.post('/register', async (c) => {
    const base = baseUrlFor(c, config.publicUrl);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return oauthError(c, 'invalid_client_metadata', 'Body must be JSON');
    const redirectUris = body.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every((u) => typeof u === 'string')) {
      return oauthError(c, 'invalid_redirect_uri', 'redirect_uris is required');
    }
    const rejected = (redirectUris as string[]).filter((u) => !isRedirectAllowed(u, config.auth.extraRedirectUris));
    if (rejected.length) {
      return oauthError(c, 'invalid_redirect_uri', `Redirect URI not allowed on this server: ${rejected.join(', ')}`);
    }
    const authMethod = body.token_endpoint_auth_method ?? 'none';
    if (authMethod !== 'none') {
      return oauthError(c, 'invalid_client_metadata', 'Only public clients (token_endpoint_auth_method "none") are supported');
    }
    const clientName = typeof body.client_name === 'string' ? body.client_name.slice(0, 100) : undefined;
    const clientId = await tokens.issueClientId(base, { redirect_uris: redirectUris as string[], client_name: clientName });
    c.header('Cache-Control', 'no-store');
    return c.json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: clientName,
        redirect_uris: redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: SCOPE,
      },
      201,
    );
  });

  // ---- Authorization endpoint -------------------------------------------------------

  /**
   * Validate client + redirect first. Until both are trusted, errors are shown
   * on our own page and never redirected (RFC 6749 §4.1.2.1).
   */
  async function validateAuthorizeRequest(
    c: Context,
    params: Record<string, string>,
  ): Promise<{ client: ResolvedClient; redirect: URL } | Response> {
    const base = baseUrlFor(c, config.publicUrl);
    let client: ResolvedClient;
    try {
      client = await resolveClient(base, params.client_id, tokens, cimdFetch);
    } catch (error) {
      htmlHeaders(c);
      return c.html(errorPage(error instanceof ClientError ? error.message : 'Invalid client'), 400);
    }
    const requested = params.redirect_uri || (client.redirectUris.length === 1 ? client.redirectUris[0]! : '');
    if (
      !requested ||
      !client.redirectUris.some((r) => redirectMatches(r, requested)) ||
      !isRedirectAllowed(requested, config.auth.extraRedirectUris)
    ) {
      htmlHeaders(c);
      return c.html(errorPage('redirect_uri is missing, not registered for this client, or not allowed on this server.'), 400);
    }
    return { client, redirect: new URL(requested) };
  }

  function redirectWith(c: Context, redirect: URL, params: Record<string, string | undefined>) {
    const url = new URL(redirect);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
    c.header('Cache-Control', 'no-store');
    return c.redirect(url.toString(), 302);
  }

  /** Protocol-level checks that may be reported back to the client via redirect. */
  function protocolError(params: Record<string, string>, resource: string): { error: string; description: string } | undefined {
    if (params.response_type !== 'code') return { error: 'unsupported_response_type', description: 'response_type must be code' };
    if (!params.code_challenge) return { error: 'invalid_request', description: 'PKCE code_challenge is required' };
    if ((params.code_challenge_method || 'plain') !== 'S256') {
      return { error: 'invalid_request', description: 'code_challenge_method must be S256' };
    }
    if (params.resource && !sameResource(params.resource, resource)) {
      return { error: 'invalid_target', description: `resource must be ${resource}` };
    }
    return undefined;
  }

  app.get('/authorize', async (c) => {
    const base = baseUrlFor(c, config.publicUrl);
    const resource = `${base}${MCP_PATH}`;
    const params = Object.fromEntries(AUTHORIZE_PARAMS.map((k) => [k, c.req.query(k) ?? '']));
    const validated = await validateAuthorizeRequest(c, params);
    if (validated instanceof Response) return validated;
    const { client, redirect } = validated;
    params.redirect_uri = redirect.toString();

    const problem = protocolError(params, resource);
    if (problem) {
      return redirectWith(c, redirect, { error: problem.error, error_description: problem.description, state: params.state || undefined, iss: base });
    }
    htmlHeaders(c, redirect.origin);
    return c.html(consentPage({ clientName: client.name ?? 'An MCP client', redirectHost: redirect.host, params }));
  });

  app.post('/authorize', async (c) => {
    const base = baseUrlFor(c, config.publicUrl);
    const resource = `${base}${MCP_PATH}`;
    const form = await formOrJson(c);
    const params = Object.fromEntries(AUTHORIZE_PARAMS.map((k) => [k, form[k] ?? '']));
    const validated = await validateAuthorizeRequest(c, params);
    if (validated instanceof Response) return validated;
    const { client, redirect } = validated;
    const state = params.state || undefined;

    const problem = protocolError(params, resource);
    if (problem) return redirectWith(c, redirect, { error: problem.error, error_description: problem.description, state, iss: base });

    if (form.decision === 'deny') {
      return redirectWith(c, redirect, { error: 'access_denied', error_description: 'The owner denied access', state, iss: base });
    }

    const ip = clientIp(c);
    const page = (error: string, status: 401 | 429) => {
      htmlHeaders(c, redirect.origin);
      return c.html(consentPage({ clientName: client.name ?? 'An MCP client', redirectHost: redirect.host, params, error }), status);
    };
    if (throttle.blocked(ip)) return page('Too many failed attempts. Try again in 15 minutes.', 429);
    if (!safeEqual(form.password ?? '', config.auth.ownerPassword)) {
      throttle.fail(ip);
      return page('Wrong password.', 401);
    }

    const code = await tokens.issueCode(base, {
      cid: client.clientId,
      ruri: params.redirect_uri!,
      cc: params.code_challenge!,
      scope: SCOPE,
      resource,
    });
    return redirectWith(c, redirect, { code, state, iss: base });
  });

  // ---- Token endpoint -----------------------------------------------------------

  app.post('/token', async (c) => {
    const base = baseUrlFor(c, config.publicUrl);
    const resource = `${base}${MCP_PATH}`;
    const form = await formOrJson(c);

    if (form.resource && !sameResource(form.resource, resource)) {
      return oauthError(c, 'invalid_target', `resource must be ${resource}`);
    }

    if (form.grant_type === 'authorization_code') {
      if (!form.code || !form.code_verifier || !form.client_id) {
        return oauthError(c, 'invalid_request', 'code, code_verifier and client_id are required');
      }
      let claims;
      try {
        claims = await tokens.redeemCode(base, form.code);
      } catch {
        return oauthError(c, 'invalid_grant', 'Authorization code is invalid, expired or already used');
      }
      if (claims.cid !== form.client_id) return oauthError(c, 'invalid_grant', 'client_id does not match the authorization code');
      if (form.redirect_uri && form.redirect_uri !== claims.ruri) {
        return oauthError(c, 'invalid_grant', 'redirect_uri does not match the authorization request');
      }
      if (!safeEqual(pkceS256(form.code_verifier), claims.cc)) return oauthError(c, 'invalid_grant', 'PKCE verification failed');
      c.header('Cache-Control', 'no-store');
      return c.json(await tokens.issueTokens(base, { cid: claims.cid, scope: claims.scope, resource: claims.resource }));
    }

    if (form.grant_type === 'refresh_token') {
      if (!form.refresh_token) return oauthError(c, 'invalid_request', 'refresh_token is required');
      let claims;
      try {
        claims = await tokens.redeemRefreshToken(base, form.refresh_token);
      } catch {
        return oauthError(c, 'invalid_grant', 'Refresh token is invalid, expired or already used');
      }
      if (form.client_id && form.client_id !== claims.cid) return oauthError(c, 'invalid_grant', 'client_id does not match');
      c.header('Cache-Control', 'no-store');
      return c.json(await tokens.issueTokens(base, claims));
    }

    return oauthError(c, 'unsupported_grant_type', 'Supported grant types: authorization_code, refresh_token');
  });

  // ---- MCP endpoint ---------------------------------------------------------------

  app.all(MCP_PATH, async (c) => {
    const base = baseUrlFor(c, config.publicUrl);
    const resource = `${base}${MCP_PATH}`;
    const gate = requireBearerAuth({
      verifier: {
        async verifyAccessToken(token: string): Promise<AuthInfo> {
          try {
            const claims = await tokens.verifyAccessToken(base, token, resource);
            return {
              token,
              clientId: claims.cid,
              scopes: claims.scope.split(' ').filter(Boolean),
              expiresAt: claims.exp,
              resource: new URL(claims.aud),
            };
          } catch {
            throw new OAuthError('invalid_token', 'Invalid or expired access token');
          }
        },
      },
      requiredScopes: [SCOPE],
      expectedResource: new URL(resource),
      resourceMetadataUrl: `${base}/.well-known/oauth-protected-resource${MCP_PATH}`,
    });
    const auth = await gate(c.req.raw);
    if (auth instanceof Response) return auth;
    return mcp.fetch(c.req.raw, { authInfo: auth });
  });

  return app;
}
