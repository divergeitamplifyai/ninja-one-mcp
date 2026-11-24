/**
 * Cloudflare Workers lane. Wrangler bundles this file (root wrangler.jsonc,
 * "main": "src/worker/index.ts"); tsc also builds it to dist/worker/ so the
 * tests can run it under Node.
 *
 * Same server factory and the same web-standard handler as the Node lane
 * (src/remote/handler.ts), so the Worker refuses exactly what Node refuses.
 * Worker-specific rules (LANES.md, "Cloudflare Workers"):
 *  - Auth is MCP_HTTP_AUTH=access (Cloudflare Access application token, team
 *    domain and AUD pinned, keys from the team JWKS) or MCP_HTTP_AUTH=bearer
 *    (MCP_BEARER_TOKEN, 32+ characters, a wrangler secret). Anything else,
 *    including nothing, answers 503 on /mcp: a Worker is never on loopback,
 *    so there is no unauthenticated mode.
 *  - Gates come from wrangler vars (<PREFIX>_MODE, <PREFIX>_ALLOW_DESTRUCTIVE),
 *    committed as read and false. The vendor credential is a wrangler secret.
 *  - Stateless: a new McpServer per request; only deployment-level settings
 *    are cached per isolate.
 */

import { loadConfig, type Config } from '../config.js';
import { registerSecret } from '../redact.js';
import { makeAuthenticator, remoteKeys, type Authenticator, type KeyResolverFactory } from '../remote/auth.js';
import { createMcpHandler, type McpHandler } from '../remote/handler.js';
import { loadRemoteSettings, type RemoteSettings } from '../remote/settings.js';

/** The part of the Workers ExecutionContext this file uses, declared here to avoid a types dependency. */
export interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Wrangler vars and secrets. Only string values are read. */
export type WorkerEnv = Record<string, unknown>;

interface Deployment {
  env: WorkerEnv;
  config: Config;
  settings: RemoteSettings;
  authenticate: Authenticator;
  /** One handler per deployment, so the upstream token cache survives between requests. */
  handler?: McpHandler;
}

export interface WorkerOptions {
  /** JWKS resolver. Tests pass local keys; production fetches the team JWKS. */
  keyFactory?: KeyResolverFactory;
}

function stringsOf(env: WorkerEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === 'string') out[key] = value;
  return out;
}

export function createWorker(options: WorkerOptions = {}) {
  let cached: Deployment | undefined;

  function deploymentFor(env: WorkerEnv): Deployment {
    // The env object is stable per isolate and deployment; rebuild only when it changes.
    if (cached && cached.env === env) return cached;
    const record = stringsOf(env);
    const config = loadConfig(record);
    registerSecret(config.clientSecret);
    registerSecret(config.clientId);
    const settings = loadRemoteSettings(record, 'worker');
    if (settings.auth.mode === 'bearer') for (const token of settings.auth.tokens) registerSecret(token);
    cached = { env, config, settings, authenticate: makeAuthenticator(settings.auth, options.keyFactory ?? remoteKeys) };
    return cached;
  }

  return {
    async fetch(request: Request, env: WorkerEnv, ctx: WorkerContext): Promise<Response> {
      const deployment = deploymentFor(env);
      deployment.handler ??= createMcpHandler({
        config: deployment.config,
        settings: deployment.settings,
        authenticate: deployment.authenticate,
        transport: 'worker',
      });
      // waitUntil belongs to this request: it keeps the isolate alive while the per-request server closes.
      return deployment.handler(request, { waitUntil: (p) => ctx.waitUntil(p) });
    },
  };
}

export default createWorker();
