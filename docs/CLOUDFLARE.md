# Deploy to Cloudflare

Run ninja-one-mcp as a remote MCP server on **Cloudflare Workers and Containers**, so a team can connect to one HTTPS endpoint at the edge. It runs the same container image as the [Azure lane](AZURE.md), with the same inbound auth (Microsoft Entra ID or bearer tokens), the same safety gates and the same organization boundary.

```text
 MCP client (VS Code, Claude Code, Cursor, ...)
   │  HTTPS  POST /mcp   Authorization: Bearer <token>
   ▼
 Cloudflare edge (TLS, WAF and rate limiting rules if you add them)
   ▼
 Worker  deploy/cloudflare/src/worker.ts   (front door, no auth decisions)
   │  1. only /mcp, /healthz and the metadata paths; anything else is 404
   │  2. refuses to start a container without inbound auth configured
   │  3. bodies over 1 MB refused; caller X-Forwarded-* replaced
   │  4. passes only NINJAONE_* vars and secrets to the container
   ▼
 Durable Object ─▶ Container (the repository's Dockerfile: distroless, non-root)
   │  1. validate the token (Entra signature, issuer, audience, expiry, scope; or bearer)
   │  2. new MCP server for this request (stateless)
   │  3. gates, org boundary and toolsets from deployment settings
   │  4. call NinjaOne with the deployment's own OAuth client (never the caller's token)
   ▼
 NinjaOne Public API v2 (app/us2/eu/ca/oc.ninjarmm.com)
```

## When to pick Cloudflare over Azure

| Need | Cloudflare | Azure |
|---|---|---|
| Fastest path to an HTTPS endpoint | `wrangler deploy`, no cloud resources to plan | `azd up` provisions six resources |
| Secrets | Worker secrets (encrypted, write-only) | Key Vault with managed identity, purge protection |
| Idle cost | Containers sleep after `CONTAINER_IDLE_MINUTES`; first request after that pays a cold start of a few seconds | One always-on replica by default, no cold start |
| Network controls | WAF custom rules, rate limiting, Cloudflare Access in front | Ingress IP allowlist |
| Logs | Workers Logs (`wrangler tail`, dashboard) | Log Analytics (KQL) |
| Plan | Workers Paid (Containers need it) | Pay as you go |

Both lanes run the same server code, so the choice is about where you already operate. The trust boundaries below match the Azure ones, with Cloudflare's controls in place of Azure's.

## What gets deployed

`deploy/cloudflare/wrangler.jsonc` defines:

| Piece | Purpose | Notes |
|---|---|---|
| Worker `ninja-one-mcp` | Front door | Routing, config check, header hygiene. About 6 KiB. |
| Durable Object `NinjaOneContainer` | Owns one container each | SQLite-backed class; the Worker addresses instances `ninjaone-0` to `ninjaone-<n-1>`. |
| Container application | The server | Built from the root `Dockerfile`, instance type `basic` (1/4 vCPU, 1 GiB), up to 3 instances. |
| Worker secrets | NinjaOne client id and secret, optional bearer tokens | Set with `wrangler secret put`; never in the config file or the image. |

Why the Worker does not authenticate: the server already does, and the Azure lane depends on that code. Keeping one implementation means one set of tests, one set of fixes, and the same `WWW-Authenticate` and protected resource metadata behavior on both clouds.

Why the raw container API instead of the `@cloudflare/containers` helper: the Worker needs only start, wait for `/healthz`, and forward. Writing that against `ctx.container` keeps the lane's only dependency at Wrangler.

## Trust boundaries and abuse cases

| Boundary | Threat | Control |
|---|---|---|
| Internet to Worker | Scanning and junk traffic | Only four paths are served. Everything else is a 404 from the Worker and never starts a container. Add WAF custom rules or rate limiting on the route for more. |
| Internet to Worker | A deployment with auth left off | The Worker refuses to start a container unless `NINJAONE_HTTP_AUTH` is `entra` (with tenant and client id) or `bearer` (with tokens), and answers 500 with the fix. The server would refuse too, since it listens on `0.0.0.0` in the container. |
| Caller to server | A stolen or forged token | Validated in the container exactly as on Azure: RS256 against the tenant JWKS, issuer, `tid`, audience, `exp`/`nbf`, required scope or role. Bearer tokens are compared in constant time and must be 32 or more characters. |
| Caller to server | Spoofed `X-Forwarded-Host` to bend the metadata URL | The Worker deletes every caller `X-Forwarded-*` header and sets its own. Set `NINJAONE_HTTP_PUBLIC_URL` and the server ignores the headers entirely. |
| Caller to server | Browser CSRF or DNS rebinding | Any `Origin` must be on `NINJAONE_HTTP_ALLOWED_ORIGINS`. |
| Worker to container | Settings leaking in or being overridden | Only `NINJAONE_*` strings cross. `NINJAONE_TRANSPORT`, `NINJAONE_HTTP_HOST`, `NINJAONE_HTTP_PORT` and `NINJAONE_ENV_FILE` are dropped, so a var cannot change the listener. |
| Server to NinjaOne | Token passthrough or a confused deputy | The caller's token is never forwarded. Every caller acts as the deployment's NinjaOne API client, so limit it with scopes, gates and `NINJAONE_ALLOWED_ORG_IDS`. |
| Secrets at rest | Secret sprawl | Worker secrets are write-only in the dashboard and API. They reach the container as environment variables at start and are redacted from every result, error and log. |
| Supply chain | Tampered image | Wrangler builds the image from the repository's `Dockerfile`, with digest-pinned bases, a distroless runtime and a non-root user, and pushes it to your account's Cloudflare registry. |

The same limitation as Azure applies: every caller shares the deployment's NinjaOne identity. Run separate Workers (different `name`, different API client, different gates) for read-only and write-enabled audiences.

## Deploy

### Prerequisites

- A Cloudflare account on the **Workers Paid** plan (Containers require it).
- Docker running locally, or deploy from GitHub Actions (below). Wrangler builds the image with Docker.
- Node.js 22 or later.
- A NinjaOne API client: platform API Services, grant Client Credentials, scope `monitoring` (see the README).
- For Entra sign-in: rights to create an app registration (the Azure lane's `infra/scripts/entra-app.sh` works for this lane too; it needs only `az`).

### 1. Install and sign in

```bash
cd deploy/cloudflare
npm ci
npx wrangler login
```

### 2. Choose inbound auth

**Entra ID (recommended).** Register the app, then put its values in `wrangler.jsonc` `vars`:

```bash
../../infra/scripts/entra-app.sh "NinjaOne MCP"
```

```jsonc
"NINJAONE_HTTP_AUTH": "entra",
"NINJAONE_HTTP_ENTRA_TENANT_ID": "<tenant-guid>",
"NINJAONE_HTTP_ENTRA_CLIENT_ID": "<client-id>",
```

Without an azd environment the script prints the three values to set. Restrict sign-in with `az ad sp update --id <client-id> --set appRoleAssignmentRequired=true` and assign users or a group.

**Bearer tokens.** For clients that cannot do OAuth:

```jsonc
"NINJAONE_HTTP_AUTH": "bearer",
```

```bash
openssl rand -base64 48 | npx wrangler secret put NINJAONE_HTTP_BEARER_TOKENS
```

Keep the token in your password manager; Cloudflare will not show it again.

### 3. Set the NinjaOne credentials

```bash
npx wrangler secret put NINJAONE_CLIENT_ID
npx wrangler secret put NINJAONE_CLIENT_SECRET
```

Each command prompts for the value. On a Worker that does not exist yet, Wrangler offers to create it.

Optional settings go in `vars` (same meaning as in the README): `NINJAONE_REGION`, `NINJAONE_ALLOWED_ORG_IDS`, `NINJAONE_TOOLSETS`, `NINJAONE_MODE` (only if writes are intended), `NINJAONE_SCOPES`.

### 4. Deploy

```bash
npm test             # typecheck and the front-door tests
npx wrangler deploy
```

Wrangler builds the image, pushes it to your account's registry, deploys the Worker, and prints the URL. Set `NINJAONE_HTTP_PUBLIC_URL` to that URL (or your custom domain) and deploy again, so the protected resource metadata names the right resource. Containers take a few minutes to provision on the very first deploy.

Check it:

```bash
curl -s https://ninja-one-mcp.<subdomain>.workers.dev/healthz
curl -s https://ninja-one-mcp.<subdomain>.workers.dev/.well-known/oauth-protected-resource
```

The first request starts a container, so it can take a few seconds.

### Custom domain

In `wrangler.jsonc`, set `"workers_dev": false` and add:

```jsonc
"routes": [{ "pattern": "mcp.example.com", "custom_domain": true }]
```

The zone must be on the same Cloudflare account. Update `NINJAONE_HTTP_PUBLIC_URL` to match.

## Deploy from GitHub Actions

`.github/workflows/deploy-cloudflare.yml` deploys a chosen tag or branch by hand (Actions > Deploy to Cloudflare > Run workflow). It runs in the GitHub environment `cloudflare`; add required reviewers there to gate every run.

| Kind | Name | Value |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | API token with Workers Scripts Edit and Containers Edit on the account (plus Workers Routes Edit for a custom domain). |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | Your account id. |
| Secret (optional) | `NINJAONE_CLIENT_ID`, `NINJAONE_CLIENT_SECRET`, `NINJAONE_HTTP_BEARER_TOKENS` | Pushed to the Worker when set; left as they are when not. |
| Variable (optional) | Any `NINJAONE_*` | Overrides the default in `wrangler.jsonc` for this deployment, e.g. `NINJAONE_HTTP_ENTRA_TENANT_ID`, `NINJAONE_HTTP_PUBLIC_URL`. |

The workflow tests the Worker, pushes the secrets through stdin, deploys, and, when `NINJAONE_HTTP_PUBLIC_URL` is set, checks `/healthz` and that `POST /mcp` without a token answers 401.

## Connect clients

Same as the [Azure lane](AZURE.md#connect-clients), with the Worker URL:

```bash
claude mcp add --transport http ninjaone https://mcp.example.com/mcp
claude mcp add --transport http ninjaone https://mcp.example.com/mcp --header "Authorization: Bearer <token>"   # bearer mode
```

## Operate

**Logs.** `npx wrangler tail` streams Worker and container logs, or use Workers Logs in the dashboard. The server logs one JSON line per event:

- `http_request`: the caller's subject and the latency.
- `http_auth_refused`: the reason a request was refused.
- `write_applied` and `write_refused`: the tool name and kind, never arguments.

The Worker adds `worker_config_invalid`, `container_start_failed`, `container_exited` and `container_crashed`.

**Update.** `npx wrangler deploy` after a new release. Containers roll to the new image; in-flight requests finish first.

**Roll back.** `npx wrangler rollback` returns the Worker to its previous version. For the container image, check out the previous tag and deploy it.

**Rotate a secret.** `npx wrangler secret put NINJAONE_CLIENT_SECRET` with the new value. A secret change deploys a new version; containers pick it up on their next start (set `CONTAINER_IDLE_MINUTES` low, or redeploy, to force it). Delete the old secret in NinjaOne afterwards.

**Scale.** The server is stateless. `CONTAINER_INSTANCES` (1 to 10, and no more than `max_instances`) spreads requests over that many containers. Each instance sleeps after `CONTAINER_IDLE_MINUTES` without a request.

**Cost.** Workers Paid, plus container time while instances are awake (billed for the `basic` instance's vCPU, memory and disk), plus Durable Object requests. Estimate with Cloudflare's Containers pricing page for your usage.

## Remove

```bash
npx wrangler delete
```

This deletes the Worker, its secrets and its Durable Objects. Remove the container application and its images under **Workers & Pages > Containers** if they remain, and delete the Entra app registration separately (`az ad app delete --id <client-id>`).

## Settings reference (Cloudflare only)

| Variable | Where | Meaning |
|---|---|---|
| `CONTAINER_INSTANCES` | `vars` | Containers to spread requests over. Default 1. |
| `CONTAINER_IDLE_MINUTES` | `vars` | Minutes without a request before an instance sleeps. Default 15, 1 to 360. |
| `NINJAONE_*` | `vars` or secrets | Passed to the container. See the [Azure settings reference](AZURE.md#settings-reference-remote) and the README. |
| `NINJAONE_TRANSPORT`, `NINJAONE_HTTP_HOST`, `NINJAONE_HTTP_PORT`, `NINJAONE_ENV_FILE` | image | Fixed by the image; the Worker drops any var with these names. |
