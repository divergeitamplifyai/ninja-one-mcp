/**
 * Inbound authentication for the HTTP transport.
 *
 *  - bearer: shared tokens of at least 32 characters, compared in constant time.
 *  - entra:  Microsoft Entra ID access tokens (RS256 JWTs), verified here with
 *            node:crypto against the tenant's JWKS: signature, issuer, audience,
 *            expiry, not-before, and the required scope or app role. No
 *            dependency; keys are cached and refreshed on an unknown kid.
 *
 * The inbound token is never forwarded upstream: NinjaOne is called with the
 * deployment's own OAuth client credentials.
 */

import { createPublicKey, timingSafeEqual, verify, type JsonWebKey } from 'node:crypto';
import type { InboundAuth } from './config.js';

export interface Caller {
  /** Stable subject for logs: an object id, an app id, or "token:<n>". */
  subject: string;
  kind: 'user' | 'app' | 'token';
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403 = 401,
  ) {
    super(message);
  }
}

function bearerOf(header: string | undefined): string | undefined {
  const m = /^Bearer\s+([A-Za-z0-9\-._~+/]+=*)$/i.exec(header ?? '');
  return m?.[1];
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  // Compare equal-length buffers so timing does not reveal the length either.
  const len = Math.max(x.length, y.length);
  const xp = Buffer.alloc(len);
  const yp = Buffer.alloc(len);
  x.copy(xp);
  y.copy(yp);
  return timingSafeEqual(xp, yp) && x.length === y.length;
}

// ------------------------------------------------------------------ JWKS

interface Jwk extends JsonWebKey {
  kid?: string;
  kty?: string;
  use?: string;
}

const JWKS_TTL_MS = 6 * 60 * 60_000;
const JWKS_MIN_REFRESH_MS = 60_000;

export class JwksCache {
  private keys = new Map<string, Jwk>();
  private fetchedAt = 0;
  private inflight: Promise<void> | undefined;

  constructor(private readonly url: string) {}

  private async refresh(): Promise<void> {
    if (!this.inflight) {
      this.inflight = (async () => {
        const response = await fetch(this.url, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new AuthError(`Could not fetch signing keys (${response.status}).`);
        const body = (await response.json()) as { keys?: Jwk[] };
        this.keys = new Map((body.keys ?? []).filter((k) => k.kid && k.kty === 'RSA').map((k) => [k.kid as string, k]));
        this.fetchedAt = Date.now();
      })().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  async key(kid: string): Promise<Jwk | undefined> {
    if (Date.now() - this.fetchedAt > JWKS_TTL_MS) await this.refresh();
    let key = this.keys.get(kid);
    if (!key && Date.now() - this.fetchedAt > JWKS_MIN_REFRESH_MS) {
      await this.refresh();
      key = this.keys.get(kid);
    }
    return key;
  }
}

function b64urlJson(part: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new AuthError('Malformed token.');
  }
}

const CLOCK_SKEW_S = 120;

/** Verify an Entra access token. Returns the caller, or throws AuthError. */
export async function verifyEntraToken(token: string, auth: Extract<InboundAuth, { mode: 'entra' }>, jwks: JwksCache, nowS = Date.now() / 1000): Promise<Caller> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('Malformed token.');
  const [h, p, s] = parts as [string, string, string];
  const header = b64urlJson(h);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new AuthError('Unsupported token algorithm.');
  const jwk = await jwks.key(header.kid);
  if (!jwk) throw new AuthError('Unknown signing key.');
  const ok = verify('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(s, 'base64url'));
  if (!ok) throw new AuthError('Invalid token signature.');

  const claims = b64urlJson(p);
  if (typeof claims.iss !== 'string' || !auth.issuers.includes(claims.iss)) throw new AuthError('Token issuer is not this tenant.');
  if (typeof claims.tid === 'string' && claims.tid !== auth.tenantId) throw new AuthError('Token is from another tenant.');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.some((a) => typeof a === 'string' && auth.audiences.includes(a))) throw new AuthError('Token audience is not this server.');
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < nowS) throw new AuthError('Token expired.');
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_S > nowS) throw new AuthError('Token not yet valid.');

  const scopes = typeof claims.scp === 'string' ? claims.scp.split(' ') : [];
  const roles = Array.isArray(claims.roles) ? (claims.roles as unknown[]).filter((r): r is string => typeof r === 'string') : [];
  const isApp = scopes.length === 0;
  if (auth.requiredRole && !roles.includes(auth.requiredRole)) throw new AuthError(`Token lacks the ${auth.requiredRole} role.`, 403);
  if (!isApp && auth.requiredScope && !scopes.includes(auth.requiredScope)) throw new AuthError(`Token lacks the ${auth.requiredScope} scope.`, 403);
  if (isApp && !auth.requiredRole) throw new AuthError('App-only tokens need an app role; set NINJAONE_HTTP_ENTRA_ROLE to allow them.', 403);

  const subject = String(claims.oid ?? claims.azp ?? claims.appid ?? claims.sub ?? 'unknown');
  return { subject, kind: isApp ? 'app' : 'user' };
}

export function makeAuthenticator(auth: InboundAuth): (authorization: string | undefined) => Promise<Caller> {
  if (auth.mode === 'none') return async () => ({ subject: 'local', kind: 'token' });
  if (auth.mode === 'bearer') {
    return async (authorization) => {
      const token = bearerOf(authorization);
      if (!token) throw new AuthError('Missing bearer token.');
      const index = auth.tokens.findIndex((t) => safeEqual(t, token));
      if (index === -1) throw new AuthError('Invalid bearer token.');
      return { subject: `token:${index + 1}`, kind: 'token' };
    };
  }
  const jwks = new JwksCache(auth.jwksUrl);
  return async (authorization) => {
    const token = bearerOf(authorization);
    if (!token) throw new AuthError('Missing bearer token.');
    return verifyEntraToken(token, auth, jwks);
  };
}
