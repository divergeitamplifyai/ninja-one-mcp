/**
 * The Worker's front-door policy, kept free of Workers-only imports so it can
 * be tested under Node (test/policy.test.mjs).
 */

export const PORT = 8080;
export const MAX_BODY_BYTES = 1_048_576;
export const READY_ATTEMPTS = 120;
export const READY_WAIT_MS = 250;
export const PUBLIC_PATHS = new Set(['/mcp', '/healthz', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']);

export interface Bindings {
  /** The container namespace (typed in worker.ts). */
  NINJAONE_MCP?: unknown;
  /** Number of container instances to spread requests over (1 to max_instances). */
  CONTAINER_INSTANCES?: string;
  /** Minutes without a request before an instance sleeps. */
  CONTAINER_IDLE_MINUTES?: string;
  /** Every NINJAONE_* var and secret is passed to the container. */
  [key: string]: unknown;
}

/** Only NINJAONE_* string settings cross into the container. */
export function containerEnv(env: Bindings): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('NINJAONE_') && typeof value === 'string' && value !== '') out[key] = value;
  }
  // The image sets these; never let a var change the listener or the transport.
  delete out.NINJAONE_TRANSPORT;
  delete out.NINJAONE_HTTP_HOST;
  delete out.NINJAONE_HTTP_PORT;
  delete out.NINJAONE_ENV_FILE;
  return out;
}

/** A configuration problem the Worker can see without starting the container. */
export function configProblem(env: Bindings): string | undefined {
  const auth = String(env.NINJAONE_HTTP_AUTH ?? '').toLowerCase();
  if (auth !== 'entra' && auth !== 'bearer') {
    return 'NINJAONE_HTTP_AUTH must be entra or bearer. Next step: set it in wrangler.jsonc vars and redeploy.';
  }
  if (auth === 'bearer' && !env.NINJAONE_HTTP_BEARER_TOKENS) {
    return 'Bearer mode needs NINJAONE_HTTP_BEARER_TOKENS. Next step: wrangler secret put NINJAONE_HTTP_BEARER_TOKENS.';
  }
  if (auth === 'entra' && (!env.NINJAONE_HTTP_ENTRA_TENANT_ID || !env.NINJAONE_HTTP_ENTRA_CLIENT_ID)) {
    return 'Entra mode needs NINJAONE_HTTP_ENTRA_TENANT_ID and NINJAONE_HTTP_ENTRA_CLIENT_ID. Next step: set them in wrangler.jsonc vars and redeploy.';
  }
  return undefined;
}

export function rpcError(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

export function intSetting(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export type FrontDoor = { response: Response } | { request: Request; instance: string };

/**
 * Decide what happens to a request before any container wakes: refuse it, or
 * forward it (with Worker-set X-Forwarded-* headers) to a named instance.
 */
export function frontDoor(request: Request, env: Bindings, random: () => number = Math.random): FrontDoor {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (!PUBLIC_PATHS.has(path)) {
    return { response: new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } }) };
  }

  const problem = configProblem(env);
  if (problem) {
    console.error(JSON.stringify({ level: 'error', event: 'worker_config_invalid', problem }));
    return { response: rpcError(500, problem) };
  }

  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > MAX_BODY_BYTES) return { response: rpcError(413, 'Request body must be JSON under 1 MB.') };

  // Only this Worker says where the request came from.
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (name.startsWith('x-forwarded-')) headers.delete(name);
  }
  headers.set('x-forwarded-proto', url.protocol.replace(':', ''));
  headers.set('x-forwarded-host', url.host);

  // The server is stateless, so any instance can answer any request.
  const instances = intSetting(env.CONTAINER_INSTANCES, 1, 1, 10);
  const instance = `ninjaone-${instances === 1 ? 0 : Math.floor(random() * instances)}`;
  return { request: new Request(request, { headers }), instance };
}
