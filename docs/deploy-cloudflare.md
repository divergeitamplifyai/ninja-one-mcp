# Deploy to Cloudflare Workers

Lane (e) of [LANES.md](../LANES.md): the server as a Worker at the edge.
Recommended auth is Cloudflare Access in front, with the Worker validating the
Access token itself; a shared bearer token is the fallback. Committed defaults
are read only and carry nothing tied to an account. The server runs in the
Worker itself (about 450 KB gzipped); no container is involved. Each request
builds a fresh server, which took 3 to 6 ms of CPU on a laptop (default and
all toolsets) before any tool runs. That is close to the Free plan's 10 ms
per-request CPU limit, so plan on Workers Paid.

```text
 MCP client
   |  HTTPS  POST /mcp
   v
 Cloudflare Access (login, service token or managed OAuth)  -- adds Cf-Access-Jwt-Assertion
   v
 Worker (src/worker/index.ts)
   1. MCP_HTTP_AUTH=access: verify the assertion (team JWKS, issuer = team domain, aud = AUD tag)
      MCP_HTTP_AUTH=bearer: constant-time compare with MCP_BEARER_TOKEN
      anything else, or incomplete: 503
   2. new MCP server for this request (stateless)
   3. gates from wrangler vars (read by default)
   4. NinjaOne with the Worker's secret API client, never the caller's token
      (the OAuth token is cached per isolate, for the deployment's credential only)
```

Because the Worker checks the Access token itself, a route that skips Access
(the `workers.dev` URL, a new custom domain) still refuses every call.

## Settings

Committed in `wrangler.jsonc`, per environment (`staging`, `production`):

| var | Committed value |
|---|---|
| `NINJAONE_REGION` | `us` |
| `NINJAONE_SCOPES` | `monitoring` |
| `NINJAONE_TOOLSETS` | `default` |
| `NINJAONE_MODE` | `read` |
| `NINJAONE_ALLOW_DESTRUCTIVE` | `false` |
| `NINJAONE_ALLOWED_ORG_IDS` | empty |
| `MCP_HTTP_AUTH` | `access` (`bearer` in the top-level dev block) |
| `MCP_ALLOWED_ORIGINS` | empty |

Never committed:

| Setting | Where it goes |
|---|---|
| `NINJAONE_CLIENT_ID`, `NINJAONE_CLIENT_SECRET` | `npx wrangler secret put <NAME> --env <env>` (listed in `secrets.required`, so a deploy without them fails) |
| `MCP_BEARER_TOKEN` | `npx wrangler secret put MCP_BEARER_TOKEN --env <env>` (bearer mode, 32+ characters) |
| `MCP_ACCESS_TEAM_DOMAIN`, `MCP_ACCESS_AUD` | GitHub environment variables, passed with `--var` by the workflow; or `--var` by hand |
| Account id, API token | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (environment secrets, or your shell) |
| Custom domain, `account_id` for local deploys | `wrangler.local.jsonc`, a git-ignored copy of `wrangler.jsonc`, used with `-c wrangler.local.jsonc` |

## Set up Access

1. Zero Trust > Access > Applications > Add a self-hosted application for the
   Worker's hostname (custom domain, or the `workers.dev` host).
2. Policies: allow the people or groups who should use the server. For
   machine clients, add a service token and a Service Auth policy.
3. Copy the application's AUD tag. Your team domain is
   `<team>.cloudflareaccess.com` (Zero Trust > Settings).
4. Store both as `MCP_ACCESS_TEAM_DOMAIN` and `MCP_ACCESS_AUD` on the GitHub
   environment (or pass them with `--var` below).

## Deploy by hand

```bash
npx wrangler login
npx wrangler secret put NINJAONE_CLIENT_ID --env staging
npx wrangler secret put NINJAONE_CLIENT_SECRET --env staging
npx wrangler deploy --env staging \
  --var MCP_ACCESS_TEAM_DOMAIN:<team>.cloudflareaccess.com \
  --var MCP_ACCESS_AUD:<aud-tag>
curl -s https://<worker-host>/healthz
```

Bearer instead of Access:

```bash
openssl rand -base64 48 | npx wrangler secret put MCP_BEARER_TOKEN --env staging
npx wrangler deploy --env staging --var MCP_HTTP_AUTH:bearer
```

Another NinjaOne instance: add `--var NINJAONE_REGION:eu` (or change the var in
a reviewed pull request).

Local development: put settings in `.dev.vars` (git-ignored) and run
`npx wrangler dev`. The top-level block uses bearer auth.

## Deploy from GitHub Actions

`.github/workflows/deploy-cloudflare.yml` does nothing until the repository
variable `DEPLOY_CLOUDFLARE_ENABLED` is `true`. Then it runs by hand only, in the
GitHub environment named like the target (`staging` or `production`);
production runs from `main` only. Add required reviewers to `production`.

| Kind | Name | Notes |
|---|---|---|
| Repository variable | `DEPLOY_CLOUDFLARE_ENABLED` | `true` turns the workflow on. |
| Environment secret | `CLOUDFLARE_API_TOKEN` | Workers Scripts: Edit, on one account. |
| Environment secret | `CLOUDFLARE_ACCOUNT_ID` | |
| Environment variable | `MCP_HTTP_AUTH` | `access` (default) or `bearer`. |
| Environment variable | `MCP_ACCESS_TEAM_DOMAIN`, `MCP_ACCESS_AUD` | Access mode. |
| Environment variable (optional) | `MCP_URL` | The `/mcp` URL to smoke test when it is not the `workers.dev` URL. |

Worker secrets (`NINJAONE_CLIENT_ID`, `NINJAONE_CLIENT_SECRET`,
`MCP_BEARER_TOKEN`) are set once with `wrangler secret put`; the workflow never
sees them. The run ends by checking `/healthz` and that `POST /mcp` without
credentials answers 401 (503 means auth is not configured, and fails the run).

## Connect clients

Through Access, clients that support Access managed OAuth sign in on their own.
Service tokens send `CF-Access-Client-Id` and `CF-Access-Client-Secret`
headers to Access. With bearer mode:

```bash
claude mcp add --transport http ninjaone https://<worker-host>/mcp --header "Authorization: Bearer <token>"
```

## Operate

- Logs: Workers Logs (observability is on). Events: `http_request`,
  `http_auth_refused`, `http_auth_unconfigured`, `http_origin_refused`.
- Open writes: grant the API client the `management` scope in NinjaOne, then
  change `NINJAONE_SCOPES` and `NINJAONE_MODE` in a reviewed pull request for
  that environment, or deploy with `--var NINJAONE_MODE:write` for a one-off,
  and redeploy without it to close them.
- Roll back: `npx wrangler rollback --env <env>`.
- Remove: `npx wrangler delete --env <env>`.
