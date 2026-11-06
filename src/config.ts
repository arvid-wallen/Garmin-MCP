/**
 * Environment configuration. Everything is read once and validated, so a
 * misconfigured deployment fails at startup with a clear message instead of
 * at the first tool call.
 */

export const DEFAULT_GARMIN_BASE_URL = 'https://personal.connectapi.garmin.com';

export interface GarminConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  /** IANA time zone used to resolve "today" and relative dates. */
  timeZone: string;
}

export interface AuthConfig {
  /** Secret used to sign every OAuth artifact (client ids, codes, tokens). */
  secret: string;
  /** Password the owner types on the consent page. */
  ownerPassword: string;
  /** Bump to revoke every issued token at once. */
  tokenVersion: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  /** Redirect URIs accepted in addition to Claude's and loopback ones. */
  extraRedirectUris: string[];
}

export interface HttpConfig {
  garmin: GarminConfig;
  auth: AuthConfig;
  /** Public origin, e.g. https://garmin-mcp.vercel.app. Undefined = derive from request. */
  publicUrl?: string;
}

type Env = Record<string, string | undefined>;

export class ConfigError extends Error {}

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`Missing required environment variable ${name}`);
  return value;
}

function intEnv(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new ConfigError(`${name} must be a positive integer`);
  return n;
}

export function loadGarminConfig(env: Env = process.env): GarminConfig {
  return {
    apiKey: required(env, 'GARMIN_PERSONAL_API_KEY'),
    baseUrl: (env.GARMIN_PERSONAL_API_BASE_URL?.trim() || DEFAULT_GARMIN_BASE_URL).replace(/\/+$/, ''),
    timeoutMs: intEnv(env, 'GARMIN_TIMEOUT_MS', 30_000),
    timeZone: env.GARMIN_TIMEZONE?.trim() || 'Europe/Stockholm',
  };
}

export function loadAuthConfig(env: Env = process.env): AuthConfig {
  const secret = required(env, 'AUTH_SECRET');
  if (secret.length < 32) throw new ConfigError('AUTH_SECRET must be at least 32 characters');
  const ownerPassword = required(env, 'OWNER_PASSWORD');
  if (ownerPassword.length < 12) throw new ConfigError('OWNER_PASSWORD must be at least 12 characters');
  return {
    secret,
    ownerPassword,
    tokenVersion: env.TOKEN_VERSION?.trim() || '1',
    accessTokenTtlSeconds: intEnv(env, 'ACCESS_TOKEN_TTL_SECONDS', 3600),
    refreshTokenTtlSeconds: intEnv(env, 'REFRESH_TOKEN_TTL_SECONDS', 60 * 60 * 24 * 30),
    extraRedirectUris: (env.EXTRA_REDIRECT_URIS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

export function loadPublicUrl(env: Env = process.env): string | undefined {
  const explicit = env.PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  if (env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (env.RAILWAY_PUBLIC_DOMAIN) return `https://${env.RAILWAY_PUBLIC_DOMAIN}`;
  return undefined;
}

export function loadHttpConfig(env: Env = process.env): HttpConfig {
  return { garmin: loadGarminConfig(env), auth: loadAuthConfig(env), publicUrl: loadPublicUrl(env) };
}
