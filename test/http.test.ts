import { createHash, randomBytes } from 'node:crypto';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { fakeGarmin, httpConfig, json } from './helpers.js';

const BASE = 'https://mcp.example.com';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

function setup() {
  const garmin = fakeGarmin([
    [/userprofile/, () => json({ displayName: 'arvid', timeZone: 'Europe/Stockholm' })],
    [/stats\/steps\/daily/, (url) => json([{ calendarDate: url.pathname.split('/')[5], totalSteps: 1000 }])],
  ]);
  const cimdDoc = {
    client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
    client_name: 'Claude',
    redirect_uris: [CALLBACK],
    token_endpoint_auth_method: 'none',
  };
  const cimdFetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    return url === cimdDoc.client_id ? json(cimdDoc) : new Response('nope', { status: 404 });
  }) as typeof fetch;
  const app = createApp(httpConfig, { garminFetch: garmin.fetch, cimdFetch });
  const req = (path: string, init?: RequestInit) => app.fetch(new Request(BASE + path, init));
  return { app, req, garmin, cimdDoc };
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function authorize(req: ReturnType<typeof setup>['req'], clientId: string, password = httpConfig.auth.ownerPassword) {
  const { verifier, challenge } = pkce();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    state: 'st4te',
    scope: 'garmin:read',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${BASE}/mcp`,
  });
  const page = await req(`/authorize?${params}`);
  const form = new URLSearchParams(params);
  form.set('password', password);
  form.set('decision', 'approve');
  const post = await req('/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '203.0.113.9' },
    body: form,
  });
  return { page, post, verifier };
}

async function exchange(req: ReturnType<typeof setup>['req'], body: Record<string, string>) {
  return req('/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
}

async function register(req: ReturnType<typeof setup>['req'], redirectUris = [CALLBACK]) {
  return req('/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: redirectUris, token_endpoint_auth_method: 'none' }),
  });
}

async function fullLogin(s: ReturnType<typeof setup>) {
  const clientId = ((await (await register(s.req)).json()) as { client_id: string }).client_id;
  const { post, verifier } = await authorize(s.req, clientId);
  const code = new URL(post.headers.get('location')!).searchParams.get('code')!;
  const tokens = (await (await exchange(s.req, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: CALLBACK })).json()) as {
    access_token: string;
    refresh_token: string;
  };
  return { clientId, tokens };
}

describe('OAuth discovery', () => {
  it('serves protected resource and authorization server metadata', async () => {
    const { req } = setup();
    const prm = (await (await req('/.well-known/oauth-protected-resource/mcp')).json()) as Record<string, unknown>;
    expect(prm.resource).toBe(`${BASE}/mcp`);
    expect(prm.authorization_servers).toEqual([BASE]);
    const as = (await (await req('/.well-known/oauth-authorization-server')).json()) as Record<string, unknown>;
    expect(as.issuer).toBe(BASE);
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.token_endpoint_auth_methods_supported).toEqual(['none']);
    expect(as.client_id_metadata_document_supported).toBe(true);
    expect(as.registration_endpoint).toBe(`${BASE}/register`);
  });

  it('challenges unauthenticated MCP requests with resource_metadata', async () => {
    const { req } = setup();
    const res = await req('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
  });
});

describe('OAuth flow', () => {
  it('rejects registration with foreign redirect URIs', async () => {
    const { req } = setup();
    const res = await register(req, ['https://evil.example/cb']);
    expect(res.status).toBe(400);
  });

  it('runs DCR -> authorize -> token -> refresh with rotation', async () => {
    const s = setup();
    const reg = await register(s.req);
    expect(reg.status).toBe(201);
    const clientId = ((await reg.json()) as { client_id: string }).client_id;

    const { page, post, verifier } = await authorize(s.req, clientId);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Owner password');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(post.status).toBe(302);
    const location = new URL(post.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(CALLBACK);
    expect(location.searchParams.get('state')).toBe('st4te');
    expect(location.searchParams.get('iss')).toBe(BASE);
    const code = location.searchParams.get('code')!;

    const bad = await exchange(s.req, { grant_type: 'authorization_code', code, code_verifier: 'wrong', client_id: clientId });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('invalid_grant');

    // The failed attempt consumed the code (single use).
    const reuse = await exchange(s.req, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId });
    expect(reuse.status).toBe(400);

    const { tokens } = await fullLogin(s);
    expect(tokens.access_token).toBeTruthy();

    // Refresh with a different client id than the token was issued to is refused.
    const refreshed = await exchange(s.req, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: s.cimdDoc.client_id });
    expect(refreshed.status).toBe(400);
  });

  it('refreshes and rotates refresh tokens', async () => {
    const s = setup();
    const { clientId, tokens } = await fullLogin(s);
    const r1 = await exchange(s.req, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
    expect(r1.status).toBe(200);
    const next = (await r1.json()) as { refresh_token: string; access_token: string };
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    const replay = await exchange(s.req, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('rejects wrong passwords and throttles', async () => {
    const s = setup();
    const clientId = ((await (await register(s.req)).json()) as { client_id: string }).client_id;
    const { post } = await authorize(s.req, clientId, 'wrong password!!');
    expect(post.status).toBe(401);
    for (let i = 0; i < 10; i++) await authorize(s.req, clientId, 'wrong password!!');
    const { post: blocked } = await authorize(s.req, clientId);
    expect(blocked.status).toBe(429);
  });

  it('supports Client ID Metadata Documents', async () => {
    const s = setup();
    const { post } = await authorize(s.req, s.cimdDoc.client_id);
    expect(post.status).toBe(302);
    expect(new URL(post.headers.get('location')!).searchParams.get('code')).toBeTruthy();
  });

  it('accepts loopback redirects with any port for Claude Code', async () => {
    const s = setup();
    const reg = await register(s.req, ['http://localhost/callback']);
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    const { challenge } = pkce();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'http://localhost:51234/callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const page = await s.req(`/authorize?${params}`);
    expect(page.status).toBe(200);
  });

  it('does not redirect to unregistered redirect URIs', async () => {
    const s = setup();
    const clientId = ((await (await register(s.req)).json()) as { client_id: string }).client_id;
    const params = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'https://evil.example/cb', code_challenge: 'x', code_challenge_method: 'S256' });
    const res = await s.req(`/authorize?${params}`);
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it('rejects tokens for another resource or after TOKEN_VERSION bump', async () => {
    const s = setup();
    const { tokens } = await fullLogin(s);
    const bumped = createApp({ ...httpConfig, auth: { ...httpConfig.auth, tokenVersion: '2' } }, { garminFetch: s.garmin.fetch });
    const res = await bumped.fetch(
      new Request(`${BASE}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' }, body: '{}' }),
    );
    expect(res.status).toBe(401);
  });
});

describe('MCP over HTTP', () => {
  it('lists and calls tools with a valid access token (SDK client)', async () => {
    const s = setup();
    const { tokens } = await fullLogin(s);
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      fetch: async (url, init) => s.app.fetch(new Request(url, init)),
      requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    });
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('get_daily_overview');
    expect(names).toContain('analyze_activity');
    expect(names).not.toContain('save_activity_file');
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);

    const result = await client.callTool({ name: 'get_steps', arguments: { start_date: '2026-01-01', end_date: '2026-02-15' } });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(JSON.parse(text)).toHaveLength(2);

    const profile = await client.callTool({ name: 'get_profile', arguments: {} });
    expect((profile.content as Array<{ text: string }>)[0]!.text).toContain('arvid');

    const bad = await client.callTool({ name: 'garmin_api_get', arguments: { path: '/personalapitoken-service/x' } });
    expect(bad.isError).toBe(true);
    await client.close();
  });

  it('serves 2025-era clients that send initialize (stateless legacy)', async () => {
    const s = setup();
    const { tokens } = await fullLogin(s);
    const headers = {
      authorization: `Bearer ${tokens.access_token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    const init = await s.req('/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1' } },
      }),
    });
    expect(init.status).toBe(200);
    const body = await init.text();
    expect(body).toContain('garmin-connect');

    const list = await s.req('/mcp', {
      method: 'POST',
      headers: { ...headers, 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(list.status).toBe(200);
    expect(await list.text()).toContain('search_activities');
  });
});
