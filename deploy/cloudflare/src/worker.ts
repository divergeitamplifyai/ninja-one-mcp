/**
 * ninja-one-mcp on Cloudflare: a Worker in front of a Cloudflare Container.
 *
 * The container is the same image CI builds and the Azure lane runs (the root
 * Dockerfile): distroless, non-root, Streamable HTTP on port 8080, inbound
 * auth enforced by the server itself (Entra ID or bearer tokens). The Worker
 * is a thin front door:
 *
 *  - refuses every path but /mcp, /healthz and the protected resource
 *    metadata, so stray traffic never wakes the container;
 *  - refuses to start the container without inbound auth (the server would
 *    refuse anyway; failing here gives a clear error and no cold start);
 *  - rejects bodies over 1 MB before they reach the container;
 *  - strips caller-supplied X-Forwarded-* headers and sets its own;
 *  - passes only NINJAONE_* settings (vars and secrets) to the container.
 *
 * It never reads, logs or forwards anything else. Authentication stays in the
 * container, so this lane and the Azure lane share one tested code path.
 */

import { DurableObject } from 'cloudflare:workers';

import { PORT, READY_ATTEMPTS, READY_WAIT_MS, containerEnv, frontDoor, intSetting, rpcError, type Bindings as PolicyBindings } from './policy';

interface Bindings extends PolicyBindings {
  NINJAONE_MCP: DurableObjectNamespace<NinjaOneContainer>;
}

export class NinjaOneContainer extends DurableObject<Bindings> {
  private starting: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    const container = ctx.container;
    if (container?.running) {
      // The Durable Object restarted while its container kept running.
      void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(this.idleMs()));
      this.observeExit();
    }
  }

  private idleMs(): number {
    return intSetting(this.env.CONTAINER_IDLE_MINUTES, 15, 1, 360) * 60_000;
  }

  override async fetch(request: Request): Promise<Response> {
    this.starting ??= this.startAndWait().finally(() => {
      this.starting = undefined;
    });
    try {
      await this.starting;
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'container_start_failed', error: error instanceof Error ? error.message : String(error) }));
      return rpcError(503, 'The server did not start. Next step: run `wrangler tail` and look for http_config_invalid or fatal.', { 'retry-after': '10' });
    }
    const url = new URL(request.url);
    url.protocol = 'http:';
    url.host = 'container';
    const forwarded = new Request(url, request);
    forwarded.headers.delete('host');
    return this.ctx.container!.getTcpPort(PORT).fetch(forwarded);
  }

  private async startAndWait(): Promise<void> {
    const container = this.ctx.container;
    if (!container) throw new Error('No container is attached to this Durable Object.');
    if (!container.running) {
      // Internet access is needed for NinjaOne and, in Entra mode, the tenant's signing keys.
      container.start({ enableInternet: true, env: containerEnv(this.env) });
    }
    this.observeExit();
    await container.setInactivityTimeout(this.idleMs());

    const port = container.getTcpPort(PORT);
    for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
      try {
        const res = await port.fetch('http://container/healthz', { signal: AbortSignal.timeout(1_000) });
        if (res.ok) return;
      } catch {
        // Not listening yet.
      }
      if (!container.running) throw new Error('The container exited during startup.');
      await new Promise((resolve) => setTimeout(resolve, READY_WAIT_MS));
    }
    throw new Error(`The container did not answer /healthz on port ${PORT}.`);
  }

  private observeExit(): void {
    const container = this.ctx.container;
    if (!container) return;
    this.ctx.waitUntil(
      container
        .monitor()
        .then(() => console.log(JSON.stringify({ level: 'info', event: 'container_exited' })))
        .catch((error: unknown) => console.error(JSON.stringify({ level: 'error', event: 'container_crashed', error: error instanceof Error ? error.message : String(error) }))),
    );
  }
}

export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    const decision = frontDoor(request, env);
    if ('response' in decision) return decision.response;
    return env.NINJAONE_MCP.getByName(decision.instance).fetch(decision.request);
  },
} satisfies ExportedHandler<Bindings>;
