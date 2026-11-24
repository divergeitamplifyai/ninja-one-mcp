/**
 * Streamable HTTP transport for remote hosting (Azure Container Apps).
 *
 * STANDARD.md T2, and the MCP authorization spec:
 *  - Streamable HTTP, stateless: no session ids, a fresh McpServer per request,
 *    no per-user state in module scope. The upstream NinjaOne client (OAuth
 *    token cache, org directory) is deployment-level and shared.
 *  - Inbound auth fails closed: off loopback the listener refuses to start
 *    without bearer tokens or Entra ID.
 *  - Entra mode publishes protected resource metadata (RFC 9728) and answers
 *    401 with WWW-Authenticate pointing at it, so OAuth-capable MCP clients can
 *    sign in on their own.
 *  - Origin is validated; requests from browsers not on the allowlist are refused.
 *  - The inbound token is never forwarded upstream.
 *  - Gate settings come from the deployment's environment, never the caller.
 *
 * Routes:
 *   POST /mcp                                     MCP (JSON responses)
 *   GET|DELETE /mcp                               405 (stateless: no SSE stream, no sessions)
 *   GET /.well-known/oauth-protected-resource[/mcp]  metadata (entra mode)
 *   GET /healthz                                  liveness and readiness, no auth, no upstream call
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from '../config.js';
import { SERVER_NAME, SERVER_VERSION } from '../constants.js';
import { logStderr } from '../redact.js';
import { createServer, createShared } from '../server.js';
import { AuthError, makeAuthenticator } from './auth.js';
import type { HttpConfig } from './config.js';

const MAX_BODY_BYTES = 1_048_576;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function rpcError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code: -32000, message }, id: null }, headers);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

/** The public URL this request was made to, for metadata. Prefers the configured one. */
function baseUrlFor(req: IncomingMessage, http: HttpConfig): string {
  if (http.publicUrl) return http.publicUrl;
  const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0]?.trim() || 'http';
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? `${http.host}:${http.port}`).split(',')[0]?.trim();
  return `${proto}://${host}`;
}

export function protectedResourceMetadata(base: string, http: HttpConfig): Record<string, unknown> | undefined {
  if (http.auth.mode !== 'entra') return undefined;
  return {
    resource: `${base}/mcp`,
    authorization_servers: [`https://login.microsoftonline.com/${http.auth.tenantId}/v2.0`],
    scopes_supported: http.auth.advertisedScope ? [http.auth.advertisedScope] : [],
    bearer_methods_supported: ['header'],
    resource_name: 'NinjaOne MCP',
    resource_documentation: 'https://github.com/patrickking67/ninja-one-mcp/blob/main/docs/AZURE.md',
  };
}

export function startHttpServer(config: Config, http: HttpConfig): Promise<{ close: () => Promise<void>; port: number }> {
  const shared = createShared(config);
  const authenticate = makeAuthenticator(http.auth);

  const server = createHttpServer(async (req, res) => {
    const started = Date.now();
    const requestId = randomUUID();
    res.setHeader('x-request-id', requestId);
    res.setHeader('x-content-type-options', 'nosniff');
    const url = new URL(req.url ?? '/', 'http://local');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (req.method === 'GET' && path === '/healthz') {
        return sendJson(res, 200, { status: 'ok', server: SERVER_NAME, version: SERVER_VERSION, credentials_configured: config.missing.length === 0 });
      }

      if (req.method === 'GET' && (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp')) {
        const prm = protectedResourceMetadata(baseUrlFor(req, http), http);
        return prm ? sendJson(res, 200, prm, { 'cache-control': 'public, max-age=3600' }) : sendJson(res, 404, { error: 'not_found' });
      }

      if (path !== '/mcp') return sendJson(res, 404, { error: 'not_found' });

      // Browsers send Origin; MCP desktop clients usually do not. Any Origin
      // that is present must be on the allowlist (DNS-rebinding and CSRF guard).
      const origin = req.headers.origin;
      if (origin && !http.allowedOrigins.includes(origin)) {
        return rpcError(res, 403, 'Origin not allowed.');
      }
      if (origin) {
        res.setHeader('access-control-allow-origin', origin);
        res.setHeader('vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id',
          'access-control-max-age': '3600',
        });
        return res.end();
      }
      if (req.method !== 'POST') {
        return rpcError(res, 405, 'This server is stateless: use POST /mcp.', { allow: 'POST, OPTIONS' });
      }

      let caller;
      try {
        caller = await authenticate(req.headers.authorization);
      } catch (error) {
        const status = error instanceof AuthError ? error.status : 401;
        const base = baseUrlFor(req, http);
        const challenge =
          http.auth.mode === 'entra'
            ? `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"${status === 403 ? ', error="insufficient_scope"' : ''}${http.auth.advertisedScope ? `, scope="${http.auth.advertisedScope}"` : ''}`
            : 'Bearer realm="ninja-one-mcp"';
        logStderr('warn', 'http_auth_refused', { request_id: requestId, status, reason: error instanceof Error ? error.message : 'error' });
        return rpcError(res, status, error instanceof Error ? error.message : 'Unauthorized', { 'www-authenticate': challenge });
      }

      let body: unknown;
      try {
        body = await readBody(req);
      } catch (error) {
        return rpcError(res, error instanceof Error && error.message === 'too large' ? 413 : 400, 'Request body must be JSON under 1 MB.');
      }

      const { server: mcp } = createServer(config, shared);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
      logStderr('info', 'http_request', { request_id: requestId, caller: caller.subject, caller_kind: caller.kind, ms: Date.now() - started });
    } catch (error) {
      logStderr('error', 'http_error', { request_id: requestId, error: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) rpcError(res, 500, 'Internal error.');
    }
  });

  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;

  return new Promise((resolve) => {
    server.listen(http.port, http.host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : http.port;
      logStderr('info', 'http_listening', { host: http.host, port, auth: http.auth.mode, public_url: http.publicUrl ?? null, origins: http.allowedOrigins.length });
      resolve({ port, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}
