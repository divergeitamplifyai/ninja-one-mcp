/**
 * The remote MCP endpoint as one web-standard handler: Request in, Response
 * out. The Workers lane calls it directly; the Node lane adapts node:http to
 * it. One implementation, so both lanes refuse the same things the same way.
 *
 * Routes:
 *   POST /mcp                                          MCP, JSON responses, stateless
 *   OPTIONS /mcp                                       CORS preflight (allowed origins only)
 *   GET|DELETE|other /mcp                              405: no SSE stream, no sessions
 *   GET /.well-known/oauth-protected-resource[/mcp]    RFC 9728 metadata (entra mode)
 *   GET|HEAD /healthz                                  liveness, no auth, no upstream call
 *
 * Rules (STANDARD.md T2, T3; LANES.md):
 *  - A new McpServer and transport per request. Nothing about a caller lives
 *    in module scope. The upstream NinjaOne client (its OAuth token cache) and
 *    the organization directory are created once per handler: they belong to
 *    the deployment's credential, which every caller shares.
 *  - Inbound auth fails closed: an unconfigured deployment answers 503.
 *  - Any Origin header must be on MCP_ALLOWED_ORIGINS, or 403.
 *  - Credentials are never accepted in the URL: /mcp takes no query string and
 *    no extra path segments.
 *  - The MCP transport sees only content negotiation headers. Authorization,
 *    cookies and Access assertions are dropped, so the inbound credential can
 *    never reach a tool or the upstream API.
 *  - Gate settings come from the deployment's Config, never from the request.
 *
 * Runtime-neutral: no node: imports.
 */

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Config } from '../config.js';
import { SERVER_NAME, SERVER_TITLE, SERVER_VERSION } from '../constants.js';
import { logStderr } from '../redact.js';
import { createServer, createShared, type Transport } from '../server.js';
import { AuthFailure, type Authenticator } from './auth.js';
import { REMOTE_ENV, type RemoteSettings } from './settings.js';

export const MCP_PATH = '/mcp';
export const PRM_PATH = '/.well-known/oauth-protected-resource';
export const MAX_BODY_BYTES = 1_048_576;

/** Headers the MCP transport may see. Everything else, credentials included, is dropped. */
const FORWARD_HEADERS = ['accept', 'content-type', 'mcp-protocol-version', 'user-agent'];

export interface HandlerOptions {
  config: Config;
  settings: RemoteSettings;
  authenticate: Authenticator;
  transport: Extract<Transport, 'http' | 'worker'>;
  /** Called with work that may finish after the response (Workers ctx.waitUntil). */
  waitUntil?: (promise: Promise<unknown>) => void;
}

const SECURITY_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...SECURITY_HEADERS, ...headers },
  });
}

/** A JSON-RPC error body: MCP clients read these, browsers and curl read the status. */
export function rpcError(status: number, message: string, headers: Record<string, string> = {}, code = -32000): Response {
  return json(status, { jsonrpc: '2.0', error: { code, message }, id: null }, headers);
}

function corsHeaders(origin: string | null, allowed: readonly string[]): Record<string, string> {
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'Authorization, Content-Type, Accept, Mcp-Protocol-Version',
    'access-control-expose-headers': 'WWW-Authenticate',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

/** RFC 9728 protected resource metadata, or undefined when this auth mode has none. */
export function protectedResourceMetadata(settings: RemoteSettings): Record<string, unknown> | undefined {
  const { auth, publicUrl } = settings;
  if (auth.mode !== 'entra' || !publicUrl) return undefined;
  return {
    resource: `${publicUrl}${MCP_PATH}`,
    authorization_servers: [auth.issuer],
    scopes_supported: auth.advertisedScope ? [auth.advertisedScope] : [],
    bearer_methods_supported: ['header'],
    resource_name: SERVER_TITLE,
  };
}

/** The WWW-Authenticate challenge for a refusal (RFC 6750, RFC 9728 section 5.1). */
export function challengeFor(settings: RemoteSettings, failure?: AuthFailure): string {
  const parts: string[] = [];
  const { auth, publicUrl } = settings;
  if (auth.mode === 'entra' && publicUrl) {
    parts.push(`resource_metadata="${publicUrl}${PRM_PATH}${MCP_PATH}"`);
    if (auth.advertisedScope) parts.push(`scope="${auth.advertisedScope}"`);
  } else {
    parts.push(`realm="${SERVER_NAME}"`);
  }
  if (failure?.code) parts.push(`error="${failure.code}"`);
  return `Bearer ${parts.join(', ')}`;
}

async function readCapped(request: Request): Promise<string | 'too_large'> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return 'too_large';
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return 'too_large';
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Per-request hooks. The Worker passes its ExecutionContext's waitUntil here. */
export interface RequestHooks {
  waitUntil?: (promise: Promise<unknown>) => void;
}

export type McpHandler = (request: Request, hooks?: RequestHooks) => Promise<Response>;

export function createMcpHandler(options: HandlerOptions): McpHandler {
  const { config, settings, authenticate, transport: transportName } = options;
  const waitUntil = options.waitUntil ?? ((promise: Promise<unknown>) => void promise.catch(() => undefined));
  // Deployment-level: one token cache for the deployment's own NinjaOne credential.
  const shared = createShared(config);

  async function handleMcp(request: Request, cors: Record<string, string>, started: number, finish: (promise: Promise<unknown>) => void): Promise<Response> {
    if (settings.auth.mode === 'unconfigured') {
      logStderr('error', 'http_auth_unconfigured', { problems: settings.fatal });
      return rpcError(503, `Inbound authentication is not configured. The operator must set ${REMOTE_ENV.auth} and its settings.`, cors);
    }

    let caller;
    try {
      caller = await authenticate(request.headers);
    } catch (error) {
      const failure = error instanceof AuthFailure ? error : new AuthFailure('Unauthorized.');
      logStderr('warn', 'http_auth_refused', { status: failure.status, reason: failure.message });
      return rpcError(failure.status, failure.message, { 'www-authenticate': challengeFor(settings, failure), ...cors });
    }

    const text = await readCapped(request);
    if (text === 'too_large') return rpcError(413, 'Request body exceeds 1 MB.', cors, -32600);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return rpcError(400, 'Parse error: the body is not JSON.', cors, -32700);
    }

    const headers = new Headers();
    for (const name of FORWARD_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const inner = new Request(`http://mcp.invalid${MCP_PATH}`, { method: 'POST', headers });

    // One server and one transport per request: stateless, nothing shared between callers.
    const { server } = createServer(config, { transport: transportName, shared });
    const mcpTransport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(mcpTransport);
      const response = await mcpTransport.handleRequest(inner, { parsedBody: parsed });
      const body = response.status === 202 || response.status === 204 ? null : await response.text();
      const out = new Headers(response.headers);
      for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...cors })) out.set(k, v);
      logStderr('info', 'http_request', { caller: caller.subject, caller_kind: caller.kind, status: response.status, ms: Date.now() - started });
      return new Response(body, { status: response.status, headers: out });
    } finally {
      finish(Promise.allSettled([mcpTransport.close(), server.close()]));
    }
  }

  return async function handle(request: Request, hooks: RequestHooks = {}): Promise<Response> {
    const started = Date.now();
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/healthz') {
        if (request.method !== 'GET' && request.method !== 'HEAD') return json(405, { error: 'method_not_allowed' }, { allow: 'GET, HEAD' });
        return json(200, { status: 'ok', server: SERVER_NAME, version: SERVER_VERSION });
      }

      if (path === PRM_PATH || path === `${PRM_PATH}${MCP_PATH}`) {
        if (request.method !== 'GET' && request.method !== 'HEAD') return json(405, { error: 'method_not_allowed' }, { allow: 'GET, HEAD' });
        const prm = protectedResourceMetadata(settings);
        if (!prm) return json(404, { error: 'not_found' });
        return json(200, prm, { 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' });
      }

      if (path !== MCP_PATH) return json(404, { error: 'not_found' });

      // Credentials in a URL end up in access logs, proxies and browser history.
      if (url.search !== '') {
        return rpcError(400, 'This endpoint takes no URL parameters. Send credentials in the Authorization header only.');
      }

      const origin = request.headers.get('origin');
      if (origin && !settings.allowedOrigins.includes(origin)) {
        logStderr('warn', 'http_origin_refused', { origin });
        return rpcError(403, 'Origin not allowed.');
      }
      const cors = corsHeaders(origin, settings.allowedOrigins);

      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...SECURITY_HEADERS, ...cors } });
      if (request.method !== 'POST') {
        return rpcError(405, 'This server is stateless: use POST /mcp. There is no SSE stream and no session to delete.', { allow: 'POST, OPTIONS', ...cors });
      }
      return await handleMcp(request, cors, started, hooks.waitUntil ?? waitUntil);
    } catch (error) {
      logStderr('error', 'http_error', { error: error instanceof Error ? error.message : String(error) });
      return rpcError(500, 'Internal error.', {}, -32603);
    }
  };
}
