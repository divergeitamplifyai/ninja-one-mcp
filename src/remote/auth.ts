/**
 * Inbound authentication for the remote lanes (STANDARD.md T2, LANES.md).
 *
 *  - bearer: shared tokens of at least 32 characters. Compared in constant
 *            time over SHA-256 digests, against every configured token, so
 *            neither the length nor which token matched leaks through timing.
 *  - entra:  Microsoft Entra ID v2 access tokens. Signature from the tenant
 *            JWKS, issuer, audience (this server's app registration), tid,
 *            exp and nbf, then the delegated scope or the app role.
 *  - access: Cloudflare Access application tokens from the
 *            Cf-Access-Jwt-Assertion header. Signature from the team JWKS,
 *            issuer (the team domain) and audience (the application AUD tag).
 *
 * JWT checks use jose, which runs unchanged on Node and on Workers. The
 * inbound credential is only ever read here; it is never handed to a tool or
 * sent upstream.
 *
 * Runtime-neutral: no node: imports.
 */

import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { AccessAuth, EntraAuth, InboundAuth } from './settings.js';

export interface Caller {
  /** Stable subject for logs: an object id, an app id, an email, or "token:<n>". Never the token. */
  subject: string;
  kind: 'user' | 'app' | 'token' | 'local';
}

export class AuthFailure extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403 = 401,
    /** RFC 6750 error code for the WWW-Authenticate challenge. */
    readonly code: 'invalid_request' | 'invalid_token' | 'insufficient_scope' | undefined = undefined,
  ) {
    super(message);
    this.name = 'AuthFailure';
  }
}

/** Returns the key resolver for a JWKS URL. Tests pass a local key set; production fetches the URL. */
export type KeyResolverFactory = (jwksUrl: string) => JWTVerifyGetKey;

const remoteSets = new Map<string, JWTVerifyGetKey>();

/** Deployment-level JWKS cache: the keys are public and the same for every caller. */
export const remoteKeys: KeyResolverFactory = (jwksUrl) => {
  let set = remoteSets.get(jwksUrl);
  if (!set) {
    set = createRemoteJWKSet(new URL(jwksUrl), {
      timeoutDuration: 5_000,
      cooldownDuration: 60_000,
      cacheMaxAge: 6 * 60 * 60_000,
    });
    remoteSets.set(jwksUrl, set);
  }
  return set;
};

const CLOCK_TOLERANCE_S = 60;

const encoder = new TextEncoder();

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

/** Constant-time equality over SHA-256 digests (equal length by construction). */
export async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function bearerOf(authorization: string | null): string | undefined {
  const match = /^Bearer\s+([A-Za-z0-9\-._~+/]+=*)\s*$/i.exec(authorization ?? '');
  return match?.[1];
}

function scopesOf(claims: JWTPayload): string[] {
  const scp = claims.scp;
  if (typeof scp === 'string') return scp.split(/\s+/).filter(Boolean);
  if (Array.isArray(scp)) return scp.filter((s): s is string => typeof s === 'string');
  return [];
}

function rolesOf(claims: JWTPayload): string[] {
  return Array.isArray(claims.roles) ? claims.roles.filter((r): r is string => typeof r === 'string') : [];
}

async function verify(token: string, keys: JWTVerifyGetKey, issuer: string, audience: string[]): Promise<JWTPayload> {
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer,
      audience,
      algorithms: ['RS256'],
      clockTolerance: CLOCK_TOLERANCE_S,
      requiredClaims: ['exp'],
    });
    return payload;
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) throw new AuthFailure('Token expired.', 401, 'invalid_token');
    if (error instanceof joseErrors.JWTClaimValidationFailed) {
      const claim = error.claim === 'aud' ? 'audience is not this server' : error.claim === 'iss' ? 'issuer is not trusted' : `claim ${error.claim} is invalid`;
      throw new AuthFailure(`Token ${claim}.`, 401, 'invalid_token');
    }
    if (error instanceof joseErrors.JOSEError) throw new AuthFailure('Token is not valid.', 401, 'invalid_token');
    // JWKS fetch problems and the like: still a refusal, never a pass.
    throw new AuthFailure('Token could not be verified.', 401, 'invalid_token');
  }
}

async function verifyEntra(token: string, auth: EntraAuth, keys: JWTVerifyGetKey): Promise<Caller> {
  const claims = await verify(token, keys, auth.issuer, auth.audiences);
  if (claims.tid !== auth.tenantId) throw new AuthFailure('Token is from another tenant.', 401, 'invalid_token');
  const scopes = scopesOf(claims);
  const roles = rolesOf(claims);
  const appOnly = scopes.length === 0;
  if (appOnly) {
    if (!auth.requiredRole) throw new AuthFailure('App-only tokens are not accepted by this deployment.', 403, 'insufficient_scope');
    if (!roles.includes(auth.requiredRole)) throw new AuthFailure(`Token lacks the ${auth.requiredRole} app role.`, 403, 'insufficient_scope');
  } else {
    if (auth.requiredScope && !scopes.includes(auth.requiredScope)) throw new AuthFailure(`Token lacks the ${auth.requiredScope} scope.`, 403, 'insufficient_scope');
    if (auth.requiredRole && !roles.includes(auth.requiredRole)) throw new AuthFailure(`Token lacks the ${auth.requiredRole} app role.`, 403, 'insufficient_scope');
  }
  const subject = String(claims.oid ?? claims.azp ?? claims.sub ?? 'unknown');
  return { subject, kind: appOnly ? 'app' : 'user' };
}

async function verifyAccess(token: string, auth: AccessAuth, keys: JWTVerifyGetKey): Promise<Caller> {
  const claims = await verify(token, keys, auth.teamOrigin, [auth.audience]);
  // Service tokens carry common_name instead of email.
  const subject = String(claims.email ?? claims.common_name ?? claims.sub ?? 'unknown');
  return { subject, kind: typeof claims.email === 'string' ? 'user' : 'app' };
}

export type Authenticator = (headers: Headers) => Promise<Caller>;

/** Build the authenticator for these settings. `unconfigured` always refuses; callers answer 503 before reaching it. */
export function makeAuthenticator(auth: InboundAuth, keyFactory: KeyResolverFactory = remoteKeys): Authenticator {
  switch (auth.mode) {
    case 'none':
      return async () => ({ subject: 'local', kind: 'local' });
    case 'bearer':
      return async (headers) => {
        const token = bearerOf(headers.get('authorization'));
        if (!token) throw new AuthFailure('Missing bearer token.', 401, headers.get('authorization') ? 'invalid_request' : undefined);
        let matched = -1;
        for (let i = 0; i < auth.tokens.length; i++) {
          // No early exit: every configured token is compared.
          if ((await timingSafeEqualStrings(token, auth.tokens[i] ?? '')) && matched === -1) matched = i;
        }
        if (matched === -1) throw new AuthFailure('Invalid bearer token.', 401, 'invalid_token');
        return { subject: `token:${matched + 1}`, kind: 'token' };
      };
    case 'entra': {
      const keys = keyFactory(auth.jwksUrl);
      return async (headers) => {
        const token = bearerOf(headers.get('authorization'));
        if (!token) throw new AuthFailure('Missing bearer token.', 401);
        return verifyEntra(token, auth, keys);
      };
    }
    case 'access': {
      const keys = keyFactory(auth.jwksUrl);
      return async (headers) => {
        const token = headers.get('cf-access-jwt-assertion')?.trim();
        if (!token) throw new AuthFailure('Missing Cloudflare Access token.', 401);
        return verifyAccess(token, auth, keys);
      };
    }
    case 'unconfigured':
      return async () => {
        throw new AuthFailure('Inbound authentication is not configured.', 401);
      };
  }
}
