/**
 * Remote transport settings, shared by the Node HTTP lane (src/http/) and the
 * Workers lane (src/worker/). See LANES.md, "Environment variables".
 *
 * These names are the same in every AmplifyAI server and carry no vendor
 * prefix: they describe the transport, not the vendor API. The gate settings
 * (`<PREFIX>_MODE`, `<PREFIX>_ALLOW_DESTRUCTIVE`) stay in src/config.ts and come
 * from the deployment, never from the caller.
 *
 * Parsing never throws. Problems that make a listener unsafe are collected in
 * `fatal`; the Node lane refuses to start on any of them, and the Worker
 * answers 503 on /mcp until they are fixed.
 *
 * Runtime-neutral: no node: imports, so the Worker can bundle it.
 */

type Env = Record<string, string | undefined>;

export const REMOTE_ENV = {
  auth: 'MCP_HTTP_AUTH',
  host: 'MCP_HTTP_HOST',
  port: 'MCP_HTTP_PORT',
  publicUrl: 'MCP_PUBLIC_URL',
  bearerToken: 'MCP_BEARER_TOKEN',
  allowedOrigins: 'MCP_ALLOWED_ORIGINS',
  entraTenantId: 'MCP_ENTRA_TENANT_ID',
  entraClientId: 'MCP_ENTRA_CLIENT_ID',
  entraAppIdUri: 'MCP_ENTRA_APP_ID_URI',
  entraScope: 'MCP_ENTRA_SCOPE',
  entraRole: 'MCP_ENTRA_ROLE',
  accessTeamDomain: 'MCP_ACCESS_TEAM_DOMAIN',
  accessAud: 'MCP_ACCESS_AUD',
} as const;

/** Shortest shared bearer token accepted (STANDARD.md T2). */
export const MIN_BEARER_LENGTH = 32;

export type Runtime = 'node' | 'worker';

export interface EntraAuth {
  mode: 'entra';
  tenantId: string;
  /** Accepted `aud` values: the app registration's client id and its Application ID URI. */
  audiences: string[];
  issuer: string;
  jwksUrl: string;
  /** Delegated scope a user token must carry in `scp`, e.g. "mcp.access". */
  requiredScope: string | undefined;
  /** App role an app-only token must carry in `roles`. Unset refuses app-only tokens. */
  requiredRole: string | undefined;
  /** Full scope advertised in metadata and challenges, e.g. api://<id>/mcp.access. */
  advertisedScope: string | undefined;
}

export interface AccessAuth {
  mode: 'access';
  /** https://<team>.cloudflareaccess.com, the token issuer. */
  teamOrigin: string;
  /** The Access application's AUD tag. */
  audience: string;
  jwksUrl: string;
}

export type InboundAuth =
  | { mode: 'none' }
  | { mode: 'bearer'; tokens: string[] }
  | EntraAuth
  | AccessAuth
  /** Not configured, or configured badly. /mcp answers 503 and nothing else runs. */
  | { mode: 'unconfigured' };

export interface RemoteSettings {
  runtime: Runtime;
  host: string;
  port: number;
  /** Public origin of this deployment (https), used for RFC 9728 metadata. No trailing slash. */
  publicUrl: string | undefined;
  auth: InboundAuth;
  /** Browser origins allowed to call /mcp. Any other Origin is refused with 403. */
  allowedOrigins: string[];
  /** Settings that make the listener unsafe. Node refuses to start; the Worker answers 503. */
  fatal: string[];
}

function value(env: Env, key: string): string | undefined {
  const raw = env[key]?.trim();
  return raw ? raw : undefined;
}

function list(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === '127.0.0.1' || h === '::1' || h === 'localhost' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Accepts "team", "team.cloudflareaccess.com" or "https://team.cloudflareaccess.com". */
export function accessTeamOrigin(domain: string): string | undefined {
  let d = domain.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(d)) d = d.includes('.') ? `https://${d}` : `https://${d}.cloudflareaccess.com`;
  try {
    const u = new URL(d);
    if (u.protocol !== 'https:' || !u.hostname.endsWith('.cloudflareaccess.com') || u.pathname !== '/') return undefined;
    return u.origin;
  } catch {
    return undefined;
  }
}

function parsePublicUrl(raw: string | undefined, fatal: string[]): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && !isLoopbackHost(u.hostname)) {
      fatal.push(`${REMOTE_ENV.publicUrl} must be https (plain http only for loopback).`);
      return undefined;
    }
    if (u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
      fatal.push(`${REMOTE_ENV.publicUrl} must be an origin only, like https://mcp.example.com (no path).`);
      return undefined;
    }
    return u.origin;
  } catch {
    fatal.push(`${REMOTE_ENV.publicUrl} is not an absolute URL.`);
    return undefined;
  }
}

function parseBearer(env: Env, fatal: string[]): InboundAuth {
  const tokens = list(value(env, REMOTE_ENV.bearerToken));
  if (tokens.length === 0) {
    fatal.push(`${REMOTE_ENV.auth}=bearer needs ${REMOTE_ENV.bearerToken} (one token, or several comma separated while rotating).`);
    return { mode: 'unconfigured' };
  }
  if (tokens.some((t) => t.length < MIN_BEARER_LENGTH)) {
    fatal.push(`Every token in ${REMOTE_ENV.bearerToken} must be at least ${MIN_BEARER_LENGTH} characters (openssl rand -base64 48).`);
    return { mode: 'unconfigured' };
  }
  return { mode: 'bearer', tokens };
}

function parseEntra(env: Env, publicUrl: string | undefined, fatal: string[]): InboundAuth {
  const before = fatal.length;
  const tenantId = value(env, REMOTE_ENV.entraTenantId);
  const clientId = value(env, REMOTE_ENV.entraClientId);
  if (!tenantId || !GUID.test(tenantId)) fatal.push(`${REMOTE_ENV.auth}=entra needs ${REMOTE_ENV.entraTenantId} (the directory tenant id, a GUID).`);
  if (!clientId || !GUID.test(clientId)) fatal.push(`${REMOTE_ENV.auth}=entra needs ${REMOTE_ENV.entraClientId} (the MCP server app registration's client id, a GUID).`);
  if (!publicUrl) fatal.push(`${REMOTE_ENV.auth}=entra needs ${REMOTE_ENV.publicUrl} (the https origin clients connect to) for protected resource metadata.`);
  if (fatal.length > before || !tenantId || !clientId) return { mode: 'unconfigured' };

  const appIdUri = value(env, REMOTE_ENV.entraAppIdUri) ?? `api://${clientId}`;
  const scopeRaw = value(env, REMOTE_ENV.entraScope) ?? 'mcp.access';
  const requiredScope = scopeRaw === 'none' ? undefined : scopeRaw;
  return {
    mode: 'entra',
    tenantId,
    audiences: [clientId, appIdUri],
    // v2 access tokens only: infra/scripts/entra-app.sh sets requestedAccessTokenVersion 2.
    issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
    jwksUrl: `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
    requiredScope,
    requiredRole: value(env, REMOTE_ENV.entraRole),
    advertisedScope: requiredScope ? `${appIdUri}/${requiredScope}` : undefined,
  };
}

function parseAccess(env: Env, fatal: string[]): InboundAuth {
  const domain = value(env, REMOTE_ENV.accessTeamDomain);
  const audience = value(env, REMOTE_ENV.accessAud);
  const teamOrigin = domain ? accessTeamOrigin(domain) : undefined;
  if (!teamOrigin) fatal.push(`${REMOTE_ENV.auth}=access needs ${REMOTE_ENV.accessTeamDomain} (<team>.cloudflareaccess.com).`);
  if (!audience || audience.length < 32) fatal.push(`${REMOTE_ENV.auth}=access needs ${REMOTE_ENV.accessAud} (the Access application's AUD tag).`);
  if (!teamOrigin || !audience || audience.length < 32) return { mode: 'unconfigured' };
  return { mode: 'access', teamOrigin, audience, jwksUrl: `${teamOrigin}/cdn-cgi/access/certs` };
}

/**
 * Read the remote settings. `runtime` decides which modes are allowed:
 * Node takes none (loopback only), bearer, entra or access; the Worker takes
 * bearer or access, because a Worker is never on loopback.
 */
export function loadRemoteSettings(env: Env, runtime: Runtime): RemoteSettings {
  const fatal: string[] = [];
  const host = value(env, REMOTE_ENV.host) ?? '127.0.0.1';
  const portRaw = value(env, REMOTE_ENV.port) ?? '8080';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fatal.push(`${REMOTE_ENV.port} must be a port number (got ${portRaw}).`);
  const publicUrl = parsePublicUrl(value(env, REMOTE_ENV.publicUrl), fatal);
  const allowedOrigins = list(value(env, REMOTE_ENV.allowedOrigins));
  for (const origin of allowedOrigins) {
    try {
      if (new URL(origin).origin !== origin) fatal.push(`${REMOTE_ENV.allowedOrigins} entry ${origin} must be a bare origin like https://app.example.com.`);
    } catch {
      fatal.push(`${REMOTE_ENV.allowedOrigins} entry ${origin} is not a URL origin.`);
    }
  }

  const modeRaw = value(env, REMOTE_ENV.auth)?.toLowerCase();
  const allowed = runtime === 'worker' ? ['bearer', 'access'] : ['none', 'bearer', 'entra', 'access'];
  let auth: InboundAuth = { mode: 'unconfigured' };
  if (modeRaw === undefined) {
    fatal.push(`${REMOTE_ENV.auth} is not set. Set it to ${allowed.join(', ')}.`);
  } else if (!allowed.includes(modeRaw)) {
    fatal.push(`${REMOTE_ENV.auth} is "${modeRaw}"; on ${runtime === 'worker' ? 'Cloudflare Workers' : 'Node'} it must be ${allowed.join(', ')}.`);
  } else if (modeRaw === 'none') {
    auth = { mode: 'none' };
  } else if (modeRaw === 'bearer') {
    auth = parseBearer(env, fatal);
  } else if (modeRaw === 'entra') {
    auth = parseEntra(env, publicUrl, fatal);
  } else {
    auth = parseAccess(env, fatal);
  }

  if (runtime === 'node' && auth.mode === 'none' && !isLoopbackHost(host)) {
    fatal.push(
      `Refusing to listen on ${host} with ${REMOTE_ENV.auth}=none. Set ${REMOTE_ENV.auth} to bearer, entra or access, or bind ${REMOTE_ENV.host}=127.0.0.1.`,
    );
  }

  return { runtime, host, port, publicUrl, auth: fatal.length > 0 ? { mode: 'unconfigured' } : auth, allowedOrigins, fatal };
}
