# Deployment lanes

Version 1.0, 2026-11-24. Companion to [STANDARD.md](STANDARD.md) (rules T1 to
T4 and V2 point here).

Every AmplifyAI MCP server ships the same five ways to run, with the same file
paths, the same environment variable names and the same refusals. A person who
has deployed one server has deployed all of them; a reviewer who has read one
`wrangler.jsonc` knows what to look for in the next.

The starter in this repository implements every lane except the two packaging
lanes (b and c), whose build scripts are vendor specific. `npm run check` runs
`scripts/check-remote.mjs`, which fails on any drift from this document that a
machine can see.

## 1. The lanes

| Lane | What runs | Transport | Inbound auth | Settings come from |
|---|---|---|---|---|
| (a) Local stdio | `node dist/index.js` | stdio | none (local process) | MCP client config `env` |
| (b) Claude Desktop bundle | `.mcpb` built from `packaging/mcpb/` | stdio | none (local process) | Desktop Settings > Extensions (`user_config`) |
| (c) Claude Code plugin | `plugins/<name>/` from `.claude-plugin/marketplace.json` | stdio | none (local process) | plugin `.mcp.json` env, from the user's environment |
| (d) Azure Container Apps | `Dockerfile` image, `node dist/http/main.js` | Streamable HTTP | `entra` (recommended) or `bearer` | azd environment, Key Vault references, GitHub environment `azure` |
| (e) Cloudflare Workers | `src/worker/index.ts` bundled by wrangler | Streamable HTTP | `access` (recommended) or `bearer` | wrangler vars and secrets, GitHub environments `staging` and `production` |

Lanes a, b and c are one process per user, holding that user's own vendor
credential. Lanes d and e are one deployment shared by many callers, holding the
deployment's credential: every caller acts as that one vendor identity, so the
gates, the organization boundary and a read-only vendor credential matter more
there, not less.

## 2. Layout

These paths are fixed. Do not move, rename or nest them.

```
.claude-plugin/marketplace.json     (c) marketplace entry, source ./plugins/<name>
plugins/<name>/.claude-plugin/plugin.json
plugins/<name>/.mcp.json            (c) starts the bundled server over stdio
packaging/mcpb/manifest.json        (b) Desktop bundle manifest and icon.png
azure.yaml                          (d) azd project, one service "mcp"
infra/main.bicep                    (d) subscription scope: resource group + module
infra/main.parameters.json          (d) azd env -> Bicep parameters, read-only defaults
infra/modules/resources.bicep       (d) everything inside the resource group
infra/scripts/entra-app.sh          (d) Entra app registration for MCP_HTTP_AUTH=entra
Dockerfile                          (d) multi-stage, digest-pinned, distroless nonroot
.dockerignore
wrangler.jsonc                      (e) Worker config, read-only defaults, no account data
src/server.ts                       createServer(config, { transport }): one factory for every lane
src/index.ts                        (a, b, c) stdio entry
src/remote/settings.ts              MCP_* parsing, shared by d and e (runtime neutral)
src/remote/auth.ts                  bearer, Entra and Access verification (runtime neutral, jose)
src/remote/handler.ts               the /mcp endpoint as Request -> Response (runtime neutral)
src/http/main.ts                    (d) Node entry: refuses unsafe settings, then listens
src/http/server.ts                  (d) node:http adapter and the loopback Host guard
src/worker/index.ts                 (e) Workers entry: export default { fetch }
src/apps/theme.ts                   THEME_CSS for every MCP Apps view (section 8)
docs/deploy-azure.md                (d) operator guide
docs/deploy-cloudflare.md           (e) operator guide
.github/workflows/ci.yml            build, test, conformance, lane checks, image, Bicep
.github/workflows/deploy-azure.yml  (d) manual, OIDC, environment "azure"
.github/workflows/deploy-cloudflare.yml  (e) manual, environments "staging" and "production"
scripts/check-remote.mjs            static lane checks, part of npm run check
```

Rules for the code:

- `src/remote/` imports nothing from `node:`. The Worker bundles it.
- `src/http/` is the only place that imports `node:http`. `src/worker/` is the
  only place that knows about Workers.
- Both remote lanes call `createMcpHandler` in `src/remote/handler.ts`. A
  refusal is implemented once, there, and tested on both lanes.
- Tools, gates and the API client know nothing about the transport. The one
  thing they see is `ctx.transport`, which `status_server` reports.

## 3. Environment variables

Two families. Vendor settings carry the server's prefix; transport settings do
not, because they mean the same thing in every server.

### Vendor and gates (`<PREFIX>_*`, every lane)

| Variable | Default | Meaning |
|---|---|---|
| `<PREFIX>_API_KEY` (or the vendor's credential names) | unset | Vendor credential. A secret: Key Vault on Azure, `wrangler secret` on Cloudflare. |
| `<PREFIX>_MODE` | `read` | First gate (STANDARD.md G2). `write` enables the write tier. |
| `<PREFIX>_ALLOW_DESTRUCTIVE` | `false` | Second gate. Needs `<PREFIX>_MODE=write`. |
| `<PREFIX>_ORG_ID`, `<PREFIX>_ALLOWED_ORG_IDS` | unset | Default organization and the hard boundary (S1, S4). |

### Remote transport (`MCP_*`, lanes d and e)

| Variable | Lane | Default | Meaning |
|---|---|---|---|
| `MCP_HTTP_AUTH` | d, e | unset (refuses) | `none`, `bearer`, `entra` or `access`. Node accepts all four, `none` on loopback only. Workers accept `bearer` and `access`. Unset or unknown: Node exits, the Worker answers 503. |
| `MCP_HTTP_HOST` | d | `127.0.0.1` | Bind address. The image sets `0.0.0.0`, which is refused without auth. |
| `MCP_HTTP_PORT` | d | `8080` | Listen port. |
| `MCP_PUBLIC_URL` | d | unset | Public https origin (no path). Required for `entra`: it is the RFC 9728 `resource`. Bicep sets it from the Container Apps domain. |
| `MCP_BEARER_TOKEN` | d, e | unset | `bearer` mode: one token, or several comma separated while rotating. Each at least 32 characters, or the server refuses to start (Node) or answers 503 (Worker). A secret. |
| `MCP_ALLOWED_ORIGINS` | d, e | empty | Comma list of browser origins allowed to call `/mcp`. Any other `Origin` gets 403. Desktop clients send no Origin. |
| `MCP_ENTRA_TENANT_ID` | d | unset | `entra` mode: directory tenant GUID. Bicep sets it from the subscription. |
| `MCP_ENTRA_CLIENT_ID` | d | unset | `entra` mode: the MCP server's app registration client id. The token audience. |
| `MCP_ENTRA_APP_ID_URI` | d | `api://<client id>` | `entra` mode: second accepted audience, prefix of the advertised scope. |
| `MCP_ENTRA_SCOPE` | d | `mcp.access` | `entra` mode: delegated scope every user token must carry. `none` drops the check. |
| `MCP_ENTRA_ROLE` | d | unset | `entra` mode: app role required in `roles`. Unset refuses app-only tokens. |
| `MCP_ACCESS_TEAM_DOMAIN` | d, e | unset | `access` mode: `<team>.cloudflareaccess.com`, the pinned issuer. |
| `MCP_ACCESS_AUD` | d, e | unset | `access` mode: the Access application's AUD tag, the pinned audience. |

Deploy-only settings (never read by the server): `MCP_MIN_REPLICAS` (azd),
`DEPLOY_AZURE_ENABLED` and `DEPLOY_CLOUDFLARE_ENABLED` (repository variables),
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (environment secrets),
`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_ENV_NAME`,
`AZURE_LOCATION` (environment variables), `MCP_URL` (smoke test target).

A server with more than one vendor credential keeps its own names for them
(`<PREFIX>_CLIENT_ID`, `<PREFIX>_CLIENT_SECRET`, ...) and wires each the same
way: a Key Vault secret and `secretRef` on Azure, a `wrangler secret` on
Cloudflare, `secrets.required` in `wrangler.jsonc`.

## 4. What every remote lane refuses

Implemented in `src/remote/` and `src/http/server.ts`, tested in
`test/http.test.mjs` and `test/worker.test.mjs`. This is STANDARD.md T2, made
concrete.

| Request or setting | Answer |
|---|---|
| `MCP_HTTP_AUTH` unset, unknown, or its settings incomplete | Node: exit 1 before listening. Worker: 503 on `/mcp`. |
| `MCP_HTTP_AUTH=none` off loopback (Node) | Exit 1 before listening. |
| Any bearer token under 32 characters | Node: exit 1. Worker: 503. |
| No credential, a wrong one, an expired or foreign-signed JWT | 401 with `WWW-Authenticate` (`resource_metadata` in `entra` mode). |
| Entra token with the wrong audience, issuer or tenant | 401, `error="invalid_token"`. |
| Entra token without the scope or role | 403, `error="insufficient_scope"`. |
| Access JWT anywhere but `Cf-Access-Jwt-Assertion`, or with the wrong AUD or team | 401. |
| `Origin` present and not on `MCP_ALLOWED_ORIGINS` | 403, before auth. |
| Loopback listener, `Host` not a loopback name | 403 (DNS rebinding guard). |
| Anything in the query string of `/mcp`, or a path below it | 400, or 404. Credentials are never read from a URL. |
| `GET`, `DELETE` or any other method on `/mcp` | 405, `Allow: POST, OPTIONS`. No SSE stream, no sessions. |
| Body over 1 MB, or not JSON | 413, or 400. |

And what every remote lane does:

- **Stateless.** A new `McpServer` and transport per request, JSON responses,
  no session id. Module scope holds only deployment settings and the public
  JWKS cache.
- **The inbound credential stays at the door.** The MCP transport receives
  only `accept`, `content-type`, `mcp-protocol-version` and `user-agent`.
  `Authorization`, cookies and the Access assertion never reach a tool, a log
  line or the vendor API, which is called with the deployment's own credential.
- **Gates from the deployment.** `<PREFIX>_MODE` and
  `<PREFIX>_ALLOW_DESTRUCTIVE` are read from the environment or wrangler vars
  once. Nothing in a request can change them.
- **`/healthz`** answers `{status, server, version}` with no auth and no
  upstream call. Container probes and deploy smoke tests use it.
- **RFC 9728** metadata at `/.well-known/oauth-protected-resource` and
  `/.well-known/oauth-protected-resource/mcp` in `entra` mode, so OAuth-capable
  clients find the authorization server on their own.

## 5. Committed deploy config (STANDARD.md T3)

- Defaults are read only everywhere: `<PREFIX>_MODE` is `read` and
  `<PREFIX>_ALLOW_DESTRUCTIVE` is `false` in every `wrangler.jsonc` block, in
  `infra/main.parameters.json` defaults, and in the Bicep parameter defaults.
  Opening a gate is a deliberate change to a GitHub environment variable or an
  azd environment, never a merged default.
- Nothing tied to an account or a person is committed: no Cloudflare
  `account_id`, no `routes` or custom hostnames, no Access team domain or AUD
  tag, no tenant, subscription or client ids, no email addresses. They live in:
  - GitHub environment variables and secrets (the deploy workflows),
  - the azd environment (`.azure/`, git-ignored) and Key Vault,
  - `wrangler secret put`, `--var` at deploy time, or a git-ignored
    `wrangler.local.jsonc` copy of `wrangler.jsonc` for local deploys.
- Secrets are never `vars`. On Azure they are Key Vault secrets referenced by
  the app's user-assigned identity; on Cloudflare they are wrangler secrets
  listed in `secrets.required`.
- Azure scales to zero by default (`minReplicas` 0); ingress is HTTPS only
  (`allowInsecure: false`). Set `MCP_MIN_REPLICAS=1` in the azd environment
  where a cold start matters.
- The image binds `0.0.0.0` and sets no auth mode. The deployment supplies
  `MCP_HTTP_AUTH`; without it the container exits instead of listening open.

## 6. Workflows (STANDARD.md R3, T4)

`ci.yml` runs on every pull request and push to `main` with
`permissions: contents: read`: `npm ci --ignore-scripts` from the lockfile,
Node from `.nvmrc` (and 22), `npm run check` (typecheck, tests, conformance,
lane checks), a wrangler dry-run bundle of both environments, `npm audit` of
production dependencies, the image build with its fail-closed and 401 checks,
`az bicep build` with no warnings, and shellcheck.

`deploy-azure.yml` and `deploy-cloudflare.yml`:

- `workflow_dispatch` only. No push, tag or schedule trigger.
- Every job carries `if: vars.DEPLOY_AZURE_ENABLED == 'true'` (or
  `DEPLOY_CLOUDFLARE_ENABLED`). A repository without the variable does nothing.
- Run in a GitHub environment (`azure`; `staging` or `production`) so
  reviewers and branch rules apply. Deploys run from `main` only (Azure always,
  Cloudflare production).
- Least permissions: `contents: read`, plus `id-token: write` for Azure OIDC.
  No Azure secret is stored in GitHub. The Cloudflare token is scoped to
  Workers Scripts Edit on one account.
- Third-party actions pinned to a full commit SHA with the release in a comment.
- End with a smoke test: `/healthz` answers 200, and `POST /mcp` with no
  credential answers 401 (a 503 there means auth is not configured, and the
  run fails).

## 7. Lanes in detail

### (a) Local stdio

`npm run build && node dist/index.js`. The client config passes the vendor
credential and gates in `env`. Nothing listens on a port. This is the lane the
conformance script exercises.

### (b) Claude Desktop bundle

`packaging/mcpb/manifest.json` (manifest version per the current MCPB spec)
with `server.entry_point` pointing at the bundled stdio server. Every
`user_config` field maps to one environment variable of section 3: the
credential is `sensitive: true`, `<PREFIX>_MODE` defaults to `read`,
`<PREFIX>_ALLOW_DESTRUCTIVE` to `false`. The built `.mcpb` is a release
artifact, never committed (`*.mcpb` is git-ignored).

### (c) Claude Code plugin

`.claude-plugin/marketplace.json` lists one plugin with
`"source": "./plugins/<name>"`. The plugin directory carries
`.claude-plugin/plugin.json`, `.mcp.json` (starts the bundled server with
`node`, passing `<PREFIX>_*` from the user's environment) and optional skills.
The plugin ships `mutations.json` unchanged (STANDARD.md M3).

### (d) Azure Container Apps

`azd up` builds the image remotely, provisions `infra/`, and deploys. Inbound
auth is Entra ID validated in the server (signature from the tenant JWKS,
issuer, audience, tenant, scope or role), not Container Apps built-in auth,
because the MCP authorization spec needs the metadata path open and a
`WWW-Authenticate` challenge that points at it. See
[docs/deploy-azure.md](docs/deploy-azure.md).

### (e) Cloudflare Workers

`npx wrangler deploy --env staging|production`. Recommended auth is Cloudflare
Access in front of the Worker, with the Worker validating the Access token
itself (team domain and AUD pinned), so a bypassed route or `workers.dev` URL
still refuses. Bearer is the fallback for clients that cannot do Access. See
[docs/deploy-cloudflare.md](docs/deploy-cloudflare.md).

## 8. View theme (STANDARD.md V2)

Every MCP Apps view uses `THEME_CSS` from `src/apps/theme.ts` as the first
thing in its `<style>`, and defines no colors, fonts or radii of its own. Repos
that carry their own palette (a `BASE_CSS` with hex values in `src/apps/shell.ts`
or a view) replace it with `THEME_CSS` and rename their tokens to the set below.

Resolution order: the host's MCP Apps variables, then DivergeIT tokens as
`light-dark()` pairs. The accent is always DivergeIT green.

| Token | Host variable | Light fallback | Dark fallback |
|---|---|---|---|
| `--fg` | `--color-text-primary` | ink `#1d1d1f` | `#f7f8f7` |
| `--muted` | `--color-text-secondary` | ink soft `#55585b` | `#b0b4b3` |
| `--subtle` | `--color-text-tertiary` | grey `#616365` | `#8b8e90` |
| `--bg` | `--color-background-primary` | `#ffffff` | `#101214` |
| `--card` | `--color-background-secondary` | wash `#f7f8f7` | `#1d1d1f` |
| `--line` | `--color-border-tertiary` | hairline `#e3e5e4` | `#2a2c2e` |
| `--line-strong` | `--color-border-secondary` | `#cdd0cf` | `#3f4245` |
| `--accent` | (none, brand) | green-600 `#007a38` | green-300 `#4dbb87` |
| `--accent-fg`, `--accent-bg` | (none, brand) | white, green-50 | `#101214`, green-900 |
| `--ok`, `--ok-bg` | `--color-text-success`, `--color-background-success` | green-600, green-50 | green-300, green tint |
| `--warn`, `--warn-bg` | `--color-text-warning`, `--color-background-warning` | `#7a6f00`, yellow-100 | yellow `#fbed23`, yellow tint |
| `--bad`, `--bad-bg` | `--color-text-danger`, `--color-background-danger` | red-700 `#8f1015`, red-100 | red-100, red tint |
| `--focus` | `--color-ring-primary` | green-600 | green-300 |
| `--sans` | `--font-sans` | `"Montserrat"`, then the system stack | same |
| `--mono` | `--font-mono` | `"JetBrains Mono"`, then the system mono stack | same |
| `--radius`, `--radius-card` | `--border-radius-sm`, `--border-radius-md` | 4px, 6px | same |
| `--hair` | `--border-width-regular` | 1px | same |

Rules: fonts never load from the network (no `@import`, no `url()`); red and
yellow are status only; hairlines, not shadows. Base styles cover `table`,
`.tablewrap`, `.badge` (`.ok`, `.warn`, `.bad`, `.accent`), `button`
(`.primary`, `.danger`), `.card`, `.grid`, `.empty`, `.error` and focus rings.

## 9. README

Every server's README follows [README.template.md](README.template.md): the
same sections in the same order, so a reader finds Install, Safety model and
Remote hosting in the same place in every repo.

## 10. Adopting the kit in a server repo

1. Branch from the default branch. Copy from this repo, unchanged except for
   the prefix: `src/remote/`, `src/http/`, `src/worker/`, `src/apps/theme.ts`,
   `Dockerfile`, `.dockerignore`, `azure.yaml`, `infra/`, `wrangler.jsonc`,
   `docs/deploy-azure.md`, `docs/deploy-cloudflare.md`, the three workflows,
   `scripts/check-remote.mjs`, `LANES.md`, `README.template.md`, and the new
   `.gitignore` lines.
2. Replace `EXAMPLE`/`example` with the server's prefixes in `wrangler.jsonc`
   (names and vars), `infra/` (env names, secret names, parameter text),
   `deploy-azure.yml` and the docs. Add one Key Vault secret, `secretRef` and
   `secrets.required` entry per vendor credential.
3. Make the server factory take `createServer(config, { transport })` and put
   `transport` on the tool context; `status_server` reports it. Make
   `logStderr` fall back to `console.error` when there is no `process.stderr`.
4. Delete the repo's own HTTP transport, Worker and front-door code, and move
   any behavior they had that is not in section 4 into an issue rather than
   back into the lanes.
5. Replace the repo's view palette with `THEME_CSS`.
6. Add `jose` (exact pin) and `wrangler` (exact pin, dev) if missing, and the
   `start:http` and `check:remote` scripts; `check` ends with
   `npm run check:remote`.
7. Copy `test/http.test.mjs`, `test/worker.test.mjs`, `test/theme.test.mjs`
   and `test/remote-harness.mjs`, rename tool and variable names, and keep
   every refusal case.
8. Rewrite the README to README.template.md.
9. `npm ci && npm run check`, `npx wrangler deploy --dry-run --env staging`,
   `az bicep build --file infra/main.bicep`, `docker build .` and the two
   container checks from `ci.yml`. Open a draft pull request. Do not set
   `DEPLOY_*_ENABLED`, deploy, or touch cloud resources from the pull request.
