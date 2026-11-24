/**
 * Remote HTTP configuration (STANDARD.md T2). Read only when the server runs
 * with --http or NINJAONE_TRANSPORT=http. Fails closed: a listener that is not
 * loopback refuses to start without inbound authentication.
 */

import { ENV_PREFIX } from '../constants.js';
import { isLoopback } from '../config.js';

type Env = Record<string, string | undefined>;

export type InboundAuth =
  | { mode: 'none' }
  | { mode: 'bearer'; tokens: string[] }
  | {
      mode: 'entra';
      tenantId: string;
      /** Accepted token audiences: the app registration's client id and Application ID URI. */
      audiences: string[];
      /** Delegated scope every token must carry, e.g. "mcp.access". Empty for app-only tokens. */
      requiredScope: string | undefined;
      /** Optional app role (for app-only tokens or role-based access). */
      requiredRole: string | undefined;
      /** Full scope advertised in protected resource metadata, e.g. api://<id>/mcp.access. */
      advertisedScope: string | undefined;
      jwksUrl: string;
      issuers: string[];
    };

export interface HttpConfig {
  host: string;
  port: number;
  /** Public base URL of this server (for protected resource metadata), e.g. https://mcp.example.com. */
  publicUrl: string | undefined;
  auth: InboundAuth;
  /** Browser origins allowed to call the server. Requests with any other Origin are refused. */
  allowedOrigins: string[];
  problems: string[];
  /** Fatal problems: the server must not start. */
  fatal: string[];
}

export const HTTP_ENV = {
  transport: `${ENV_PREFIX}_TRANSPORT`,
  host: `${ENV_PREFIX}_HTTP_HOST`,
  port: `${ENV_PREFIX}_HTTP_PORT`,
  publicUrl: `${ENV_PREFIX}_HTTP_PUBLIC_URL`,
  auth: `${ENV_PREFIX}_HTTP_AUTH`,
  tokens: `${ENV_PREFIX}_HTTP_BEARER_TOKENS`,
  tenantId: `${ENV_PREFIX}_HTTP_ENTRA_TENANT_ID`,
  clientId: `${ENV_PREFIX}_HTTP_ENTRA_CLIENT_ID`,
  appIdUri: `${ENV_PREFIX}_HTTP_ENTRA_APP_ID_URI`,
  scope: `${ENV_PREFIX}_HTTP_ENTRA_SCOPE`,
  role: `${ENV_PREFIX}_HTTP_ENTRA_ROLE`,
  jwksUrl: `${ENV_PREFIX}_HTTP_ENTRA_JWKS_URL`,
  origins: `${ENV_PREFIX}_HTTP_ALLOWED_ORIGINS`,
} as const;

const MIN_TOKEN_LENGTH = 32;

function value(env: Env, key: string): string | undefined {
  const raw = env[key]?.trim();
  return raw ? raw : undefined;
}

function list(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function wantsHttp(argv: string[], env: Env): boolean {
  return argv.includes('--http') || value(env, HTTP_ENV.transport)?.toLowerCase() === 'http';
}

export function loadHttpConfig(env: Env = process.env): HttpConfig {
  const problems: string[] = [];
  const fatal: string[] = [];
  const host = value(env, HTTP_ENV.host) ?? '127.0.0.1';
  const port = Number(value(env, HTTP_ENV.port) ?? env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fatal.push(`${HTTP_ENV.port} must be a port number.`);

  let publicUrl = value(env, HTTP_ENV.publicUrl)?.replace(/\/+$/, '');
  if (publicUrl) {
    try {
      const u = new URL(publicUrl);
      if (u.protocol !== 'https:' && !isLoopback(u.hostname)) fatal.push(`${HTTP_ENV.publicUrl} must be https.`);
    } catch {
      fatal.push(`${HTTP_ENV.publicUrl} is not a URL.`);
      publicUrl = undefined;
    }
  }

  const mode = (value(env, HTTP_ENV.auth) ?? 'none').toLowerCase();
  let auth: InboundAuth = { mode: 'none' };
  if (mode === 'bearer') {
    const tokens = list(value(env, HTTP_ENV.tokens));
    const short = tokens.filter((t) => t.length < MIN_TOKEN_LENGTH);
    if (tokens.length === 0) fatal.push(`${HTTP_ENV.auth}=bearer needs ${HTTP_ENV.tokens} (one or more tokens, comma separated).`);
    if (short.length > 0) fatal.push(`Every token in ${HTTP_ENV.tokens} must be at least ${MIN_TOKEN_LENGTH} characters.`);
    auth = { mode: 'bearer', tokens: tokens.filter((t) => t.length >= MIN_TOKEN_LENGTH) };
  } else if (mode === 'entra') {
    const tenantId = value(env, HTTP_ENV.tenantId);
    const clientId = value(env, HTTP_ENV.clientId);
    if (!tenantId || !/^[0-9a-f-]{36}$/i.test(tenantId)) fatal.push(`${HTTP_ENV.auth}=entra needs ${HTTP_ENV.tenantId} (the directory tenant id, a GUID).`);
    if (!clientId) fatal.push(`${HTTP_ENV.auth}=entra needs ${HTTP_ENV.clientId} (the MCP server's app registration client id).`);
    const appIdUri = value(env, HTTP_ENV.appIdUri) ?? (clientId ? `api://${clientId}` : undefined);
    const requiredScope = value(env, HTTP_ENV.scope) ?? 'mcp.access';
    const requiredRole = value(env, HTTP_ENV.role);
    const jwksUrl = value(env, HTTP_ENV.jwksUrl) ?? `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`;
    try {
      const u = new URL(jwksUrl);
      if (u.protocol !== 'https:' && !isLoopback(u.hostname)) fatal.push(`${HTTP_ENV.jwksUrl} must be https.`);
    } catch {
      fatal.push(`${HTTP_ENV.jwksUrl} is not a URL.`);
    }
    auth = {
      mode: 'entra',
      tenantId: tenantId ?? '',
      audiences: [clientId, appIdUri].filter((a): a is string => Boolean(a)),
      requiredScope: requiredScope === 'none' ? undefined : requiredScope,
      requiredRole,
      advertisedScope: requiredScope === 'none' || !appIdUri ? undefined : `${appIdUri}/${requiredScope}`,
      jwksUrl,
      issuers: [`https://login.microsoftonline.com/${tenantId}/v2.0`, `https://sts.windows.net/${tenantId}/`],
    };
  } else if (mode !== 'none') {
    fatal.push(`${HTTP_ENV.auth} is "${mode}", which is not none, bearer or entra.`);
  }

  if (auth.mode === 'none' && !isLoopback(host)) {
    fatal.push(`Refusing to listen on ${host} without inbound authentication. Set ${HTTP_ENV.auth}=entra or bearer, or bind ${HTTP_ENV.host}=127.0.0.1.`);
  }

  return { host, port, publicUrl, auth, allowedOrigins: list(value(env, HTTP_ENV.origins)), problems, fatal };
}
