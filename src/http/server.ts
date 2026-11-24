/**
 * Node HTTP lane: node:http in front of the shared web-standard handler
 * (src/remote/handler.ts). Used by the container image (Azure Container Apps)
 * and for local remote testing. No framework, no extra dependency.
 *
 * What this file adds on top of the handler:
 *  - Refuses to start when the settings are unsafe (STANDARD.md T2): auth=none
 *    off loopback, a bearer token under 32 characters, half-configured Entra
 *    or Access.
 *  - Host guard on loopback: a loopback listener only answers requests whose
 *    Host header is a loopback name, so a web page cannot reach it through DNS
 *    rebinding.
 */

import { createServer as createNodeServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { Config } from '../config.js';
import { logStderr } from '../redact.js';
import { makeAuthenticator, remoteKeys, type KeyResolverFactory } from '../remote/auth.js';
import { createMcpHandler, rpcError } from '../remote/handler.js';
import { isLoopbackHost, type RemoteSettings } from '../remote/settings.js';

export interface HttpServerOptions {
  config: Config;
  settings: RemoteSettings;
  /** JWKS resolver. Tests pass local keys; production fetches the issuer's JWKS. */
  keyFactory?: KeyResolverFactory;
}

export interface RunningHttpServer {
  port: number;
  close: () => Promise<void>;
}

export class UnsafeSettingsError extends Error {
  constructor(readonly problems: string[]) {
    super(`Refusing to start the HTTP listener: ${problems.join(' ')}`);
    this.name = 'UnsafeSettingsError';
  }
}

/** Hostname from a Host header value, without the port. */
function hostnameOf(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return undefined;
  }
}

function toRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  // Only the path and query of the request line are used; the origin is fixed.
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(`http://127.0.0.1${url.pathname}${url.search}`, {
    method: req.method ?? 'GET',
    headers,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' } : {}),
  } as RequestInit);
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  const body = response.body ? Buffer.from(await response.arrayBuffer()) : undefined;
  res.writeHead(response.status, headers);
  res.end(body);
}

export function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  const { config, settings } = options;
  if (settings.fatal.length > 0) return Promise.reject(new UnsafeSettingsError(settings.fatal));

  const loopback = isLoopbackHost(settings.host);
  const handler = createMcpHandler({
    config,
    settings,
    authenticate: makeAuthenticator(settings.auth, options.keyFactory ?? remoteKeys),
    transport: 'http',
  });

  const server = createNodeServer((req, res) => {
    void (async () => {
      try {
        if (loopback) {
          const host = hostnameOf(req.headers.host);
          if (!host || !isLoopbackHost(host)) {
            logStderr('warn', 'http_host_refused', { host: req.headers.host ?? null });
            await send(res, rpcError(403, 'Host not allowed: this listener answers loopback names only.'));
            req.resume();
            return;
          }
        }
        await send(res, await handler(toRequest(req)));
      } catch (error) {
        logStderr('error', 'http_adapter_error', { error: error instanceof Error ? error.message : String(error) });
        if (!res.headersSent) await send(res, rpcError(500, 'Internal error.', {}, -32603));
        else res.destroy();
      }
    })();
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(settings.port, settings.host, () => {
      server.off('error', reject);
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : settings.port;
      logStderr('info', 'http_listening', {
        host: settings.host,
        port,
        auth: settings.auth.mode,
        public_url: settings.publicUrl ?? null,
        allowed_origins: settings.allowedOrigins.length,
        mode: config.writeMode ? 'write' : 'read',
        destructive_allowed: config.destructiveAllowed,
      });
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
