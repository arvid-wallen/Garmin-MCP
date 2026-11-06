import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { jwtVerify, SignJWT, type JWTPayload } from 'jose';

import type { AuthConfig } from '../config.js';

/**
 * Stateless OAuth artifacts. Every artifact (DCR client id, authorization
 * code, access token, refresh token) is a JWT signed with a key derived from
 * AUTH_SECRET for that purpose only, so one kind can never be replayed as
 * another. Nothing is stored server-side, which is what makes this work on
 * serverless hosts without a database.
 *
 * Trade-offs (single-user server):
 *  - Individual tokens cannot be revoked. Bump TOKEN_VERSION (or rotate
 *    AUTH_SECRET) to revoke everything.
 *  - Authorization-code single use and refresh-token rotation are enforced
 *    per warm instance (in memory), backed by PKCE and short code lifetimes.
 */

export type Purpose = 'client' | 'code' | 'access' | 'refresh';

export const SCOPE = 'garmin:read';
const CODE_TTL_SECONDS = 120;

export function deriveKey(secret: string, purpose: Purpose): Uint8Array {
  return new Uint8Array(createHmac('sha256', secret).update(`garmin-mcp:${purpose}:v1`).digest());
}

export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** Remember used one-time ids until they would have expired anyway. */
class UsedIds {
  private readonly ids = new Map<string, number>();
  /** Returns false if the id was already used. */
  use(id: string, expiresAtSec: number): boolean {
    const now = Date.now() / 1000;
    for (const [k, exp] of this.ids) if (exp < now) this.ids.delete(k);
    if (this.ids.has(id)) return false;
    this.ids.set(id, expiresAtSec);
    return true;
  }
}

export interface CodeClaims {
  cid: string;
  ruri: string;
  cc: string;
  scope: string;
  resource: string;
}

export interface RefreshClaims {
  cid: string;
  scope: string;
  resource: string;
}

export interface AccessClaims {
  cid: string;
  scope: string;
  aud: string;
  exp: number;
}

export class TokenService {
  private readonly keys: Record<Purpose, Uint8Array>;
  private readonly usedCodes = new UsedIds();
  private readonly usedRefresh = new UsedIds();

  constructor(private readonly config: AuthConfig) {
    this.keys = {
      client: deriveKey(config.secret, 'client'),
      code: deriveKey(config.secret, 'code'),
      access: deriveKey(config.secret, 'access'),
      refresh: deriveKey(config.secret, 'refresh'),
    };
  }

  private sign(issuer: string, purpose: Purpose, claims: JWTPayload, ttlSeconds?: number, audience?: string): Promise<string> {
    let jwt = new SignJWT({ ...claims, ver: this.config.tokenVersion })
      .setProtectedHeader({ alg: 'HS256', typ: purpose === 'access' ? 'at+jwt' : `${purpose}+jwt` })
      .setIssuer(issuer)
      .setIssuedAt();
    if (ttlSeconds !== undefined) jwt = jwt.setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds);
    if (audience) jwt = jwt.setAudience(audience);
    return jwt.sign(this.keys[purpose]);
  }

  private async verify(issuer: string, purpose: Purpose, token: string, audience?: string): Promise<JWTPayload> {
    const { payload } = await jwtVerify(token, this.keys[purpose], {
      issuer,
      audience,
      algorithms: ['HS256'],
      typ: purpose === 'access' ? 'at+jwt' : `${purpose}+jwt`,
    });
    if (payload.ver !== this.config.tokenVersion) throw new Error('Token version revoked');
    return payload;
  }

  // ---- Dynamic client registration ---------------------------------------

  issueClientId(issuer: string, metadata: { redirect_uris: string[]; client_name?: string }): Promise<string> {
    return this.sign(issuer, 'client', { redirect_uris: metadata.redirect_uris, client_name: metadata.client_name });
  }

  async verifyClientId(issuer: string, clientId: string): Promise<{ redirect_uris: string[]; client_name?: string }> {
    const payload = await this.verify(issuer, 'client', clientId);
    const uris = payload.redirect_uris;
    if (!Array.isArray(uris) || !uris.every((u) => typeof u === 'string')) throw new Error('Malformed client id');
    return { redirect_uris: uris as string[], client_name: typeof payload.client_name === 'string' ? payload.client_name : undefined };
  }

  // ---- Authorization codes ----------------------------------------------------

  issueCode(issuer: string, claims: CodeClaims): Promise<string> {
    return this.sign(issuer, 'code', { ...claims, jti: randomUUID() }, CODE_TTL_SECONDS);
  }

  async redeemCode(issuer: string, code: string): Promise<CodeClaims> {
    const p = await this.verify(issuer, 'code', code);
    if (typeof p.jti !== 'string' || typeof p.exp !== 'number' || !this.usedCodes.use(p.jti, p.exp)) {
      throw new Error('Authorization code already used');
    }
    return { cid: String(p.cid), ruri: String(p.ruri), cc: String(p.cc), scope: String(p.scope), resource: String(p.resource) };
  }

  // ---- Access / refresh tokens -----------------------------------------------

  async issueTokens(issuer: string, claims: RefreshClaims) {
    const accessToken = await this.sign(
      issuer,
      'access',
      { sub: 'owner', cid: claims.cid, scope: claims.scope },
      this.config.accessTokenTtlSeconds,
      claims.resource,
    );
    const refreshToken = await this.sign(
      issuer,
      'refresh',
      { sub: 'owner', cid: claims.cid, scope: claims.scope, resource: claims.resource, jti: randomUUID() },
      this.config.refreshTokenTtlSeconds,
    );
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: claims.scope,
    };
  }

  async redeemRefreshToken(issuer: string, token: string): Promise<RefreshClaims> {
    const p = await this.verify(issuer, 'refresh', token);
    if (typeof p.jti !== 'string' || typeof p.exp !== 'number' || !this.usedRefresh.use(p.jti, p.exp)) {
      throw new Error('Refresh token already used');
    }
    return { cid: String(p.cid), scope: String(p.scope), resource: String(p.resource) };
  }

  async verifyAccessToken(issuer: string, token: string, resource: string): Promise<AccessClaims> {
    const p = await this.verify(issuer, 'access', token, resource);
    return { cid: String(p.cid), scope: String(p.scope), aud: resource, exp: Number(p.exp) };
  }
}
