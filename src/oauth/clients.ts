import type { TokenService } from './tokens.js';

/** Claude's hosted OAuth callbacks (claude.ai, Desktop, mobile). */
export const CLAUDE_CALLBACKS = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'];

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface ResolvedClient {
  clientId: string;
  name?: string;
  redirectUris: string[];
  kind: 'dcr' | 'cimd';
}

export class ClientError extends Error {}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

export function isLoopbackRedirect(uri: string): boolean {
  const url = parseUrl(uri);
  return !!url && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

/** Server-wide allowlist: Claude's callbacks, loopback (RFC 8252, Claude Code) and configured extras. */
export function isRedirectAllowed(uri: string, extra: string[]): boolean {
  if (CLAUDE_CALLBACKS.includes(uri) || extra.includes(uri)) return true;
  return isLoopbackRedirect(uri);
}

/** Exact match, except loopback redirects where the port is ignored (RFC 8252 §7.3). */
export function redirectMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  if (!isLoopbackRedirect(registered) || !isLoopbackRedirect(requested)) return false;
  const a = new URL(registered);
  const b = new URL(requested);
  return a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
}

// ---- Client ID Metadata Documents ------------------------------------------------

const CIMD_TTL_MS = 10 * 60 * 1000;
const CIMD_MAX_BYTES = 64 * 1024;
const cimdCache = new Map<string, { at: number; client: ResolvedClient }>();

function isUrlClientId(clientId: string): boolean {
  return clientId.startsWith('https://');
}

async function fetchCimd(clientId: string, fetchImpl: typeof fetch): Promise<ResolvedClient> {
  const cached = cimdCache.get(clientId);
  if (cached && Date.now() - cached.at < CIMD_TTL_MS) return cached.client;

  const url = parseUrl(clientId);
  if (!url || url.protocol !== 'https:' || url.hash || url.username || url.password) {
    throw new ClientError('client_id metadata URL must be a plain https URL');
  }
  if (/^[\d.]+$/.test(url.hostname) || url.hostname.includes(':') || url.hostname === 'localhost') {
    throw new ClientError('client_id metadata URL must use a DNS host name');
  }
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new ClientError(`client_id metadata document returned HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > CIMD_MAX_BYTES) throw new ClientError('client_id metadata document too large');
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ClientError('client_id metadata document is not JSON');
  }
  if (doc.client_id !== clientId) throw new ClientError('client_id in metadata document does not match its URL');
  const redirectUris = doc.redirect_uris;
  if (!Array.isArray(redirectUris) || !redirectUris.every((u) => typeof u === 'string')) {
    throw new ClientError('client_id metadata document has no redirect_uris');
  }
  const client: ResolvedClient = {
    clientId,
    name: typeof doc.client_name === 'string' ? doc.client_name : url.hostname,
    redirectUris: redirectUris as string[],
    kind: 'cimd',
  };
  cimdCache.set(clientId, { at: Date.now(), client });
  return client;
}

export async function resolveClient(
  issuer: string,
  clientId: string | undefined,
  tokens: TokenService,
  fetchImpl: typeof fetch,
): Promise<ResolvedClient> {
  if (!clientId) throw new ClientError('Missing client_id');
  if (isUrlClientId(clientId)) return fetchCimd(clientId, fetchImpl);
  try {
    const meta = await tokens.verifyClientId(issuer, clientId);
    return { clientId, name: meta.client_name, redirectUris: meta.redirect_uris, kind: 'dcr' };
  } catch {
    throw new ClientError('Unknown client_id. Remove and re-add the connector to register again.');
  }
}
