# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Breaking changes

The remote lanes now use the shared deployment kit (LANES.md). Transport settings carry the kit's `MCP_*` names and there are no aliases for the old ones. Stdio, `.mcpb` and plugin settings (`NINJAONE_*`) and every tool name are unchanged.

| Old | New |
|---|---|
| `NINJAONE_HTTP_AUTH` (default `none`) | `MCP_HTTP_AUTH` (required; unset refuses to start) |
| `NINJAONE_HTTP_HOST` | `MCP_HTTP_HOST` |
| `NINJAONE_HTTP_PORT`, and the `PORT` fallback | `MCP_HTTP_PORT` (no `PORT` fallback) |
| `NINJAONE_HTTP_PUBLIC_URL` | `MCP_PUBLIC_URL` |
| `NINJAONE_HTTP_BEARER_TOKENS` | `MCP_BEARER_TOKEN` (still comma separated while rotating) |
| `NINJAONE_HTTP_ENTRA_TENANT_ID` | `MCP_ENTRA_TENANT_ID` |
| `NINJAONE_HTTP_ENTRA_CLIENT_ID` | `MCP_ENTRA_CLIENT_ID` |
| `NINJAONE_HTTP_ENTRA_APP_ID_URI` | `MCP_ENTRA_APP_ID_URI` |
| `NINJAONE_HTTP_ENTRA_SCOPE` | `MCP_ENTRA_SCOPE` |
| `NINJAONE_HTTP_ENTRA_ROLE` | `MCP_ENTRA_ROLE` |
| `NINJAONE_HTTP_ALLOWED_ORIGINS` | `MCP_ALLOWED_ORIGINS` |
| azd `MCP_INBOUND_AUTH` | azd `MCP_HTTP_AUTH` |
| `--http` flag, `NINJAONE_TRANSPORT=http` | `node dist/http/main.js` (`npm run start:http`); the image runs it |
| `NINJAONE_HTTP_ENTRA_JWKS_URL` | removed |
| Cloudflare `CONTAINER_INSTANCES`, `CONTAINER_IDLE_MINUTES` | removed with the Containers front door |

Also:

- Entra mode accepts v2 access tokens only (`infra/scripts/entra-app.sh` sets `requestedAccessTokenVersion` 2); v1 `sts.windows.net` issuers are refused.
- `/healthz` answers `{status, server, version}`; `credentials_configured` moved to `ninjaone_status_server`.
- Azure: the NinjaOne client id is now a Key Vault secret too (`azd env set-secret NINJAONE_CLIENT_ID`), the app scales to zero by default (`MCP_MIN_REPLICAS=1` to keep one replica), and the first provision runs a placeholder image until `azd deploy`. Bicep parameter names follow the kit (`region`, `clientId`, `clientSecret`, `scopes`, `toolsets`, `mode`, `allowDestructive`, `allowedOrgIds`).
- Cloudflare: `deploy/cloudflare/` (a Worker and Durable Object in front of Cloudflare Containers) is replaced by a native Worker, `src/worker/index.ts`, configured by the root `wrangler.jsonc` with `staging` and `production` environments. Auth is Cloudflare Access (recommended) or a bearer token; Entra mode is Azure only.

### Added

- **Remote lanes from the kit:** `src/remote/` (settings, jose-based Entra, Access and bearer auth, one web-standard `/mcp` handler), `src/http/` and `src/worker/`, with the refusal tests for both runtimes. Query strings on `/mcp`, non-loopback `Host` headers on a loopback listener, and any method but `POST` and `OPTIONS` are refused.
- **Deploy workflows:** manual, environment-gated `deploy-azure.yml` (OpenID Connect) and `deploy-cloudflare.yml`, off until `DEPLOY_AZURE_ENABLED` or `DEPLOY_CLOUDFLARE_ENABLED` is `true`, each ending with a smoke test.
- `npm run check:remote` (lane checks) is part of `npm run check`.
- The plugin and the `.mcpb` carry `mutations.json` beside the bundled server.

### Changed

- The repository moved to `divergeitamplifyai/ninja-one-mcp`. Links, the website address and the default image (`ghcr.io/divergeitamplifyai/ninja-one-mcp`) follow it.
- Views use the shared `THEME_CSS` (host variables first, no network fonts).
- `llms.txt` is inlined at build time, so the docs resource works on every lane.
- `@modelcontextprotocol/ext-apps` 2.0.4 for the view runtime; `jose` 6.2.17 and `wrangler` 4.160.0 added.
- STANDARD.md 1.1, CHECKLIST.md, LANES.md and README.template.md from the standards kit; the README follows the template with exact tool counts.
- `.azure/`, `.dev.vars` and `wrangler.local.jsonc` are ignored.

## [0.1.0] - 2026-11-23

First release.

### Added

- **Coverage:** all 315 operations in the NinjaOne Public API v2 (spec 2.0.9-draft), with 302 typed tools and 13 operations reachable through the gated passthrough. `docs/api-coverage.md` maps each one.
- **Tools:** 315 in all, in 16 toolsets. The default set lists 108.
- **Safety:**
  - Read-only by default, with two gates (`NINJAONE_MODE`, `NINJAONE_ALLOW_DESTRUCTIVE`), `confirm: true` on every change, and an optional write allowlist.
  - Dry runs for wide writes, and `before`/`after` read-back on writes.
  - Organization boundary (`NINJAONE_ALLOWED_ORG_IDS`) with `df` narrowing, device checks and row re-checks.
  - Secrets: secure values are never requested, signed URLs only behind both gates and `reveal: true`, and redaction everywhere.
- **Auth:** OAuth 2.0 client credentials for every NinjaOne region, with token caching and single-flight refresh.
- **Workflows:** `ninjaone_report_fleet_health`, `ninjaone_get_device_profile`, `ninjaone_list_board_tickets`, `ninjaone_add_ticket_comment`.
- **Views:** interactive MCP Apps views for the fleet, a device, and alerts.
- **Resources:** NinjaOne's public docs index (`llms.txt`) and the device filter guide.
- **Plugin:** the NinjaOne plugin for Claude Code and Codex, with a bundled server and four skills.
- **Claude Desktop:** a `.mcpb` bundle.
- **Configuration:** an optional credentials file for hosts that filter the environment.
- **Tests:**
  - A conformance suite with 5,184 checks.
  - 47 tests against a loopback NinjaOne mock that reproduces the API's dangerous behaviors, including the HTTP transport and Entra token validation.
  - CI drift checks on every generated file.
- **Website:** at https://divergeitamplifyai.github.io/ninja-one-mcp/.
- **Remote transport:** Streamable HTTP (`--http`), stateless, with Microsoft Entra ID or shared-token auth, RFC 9728 protected resource metadata, Origin checks and `/healthz`.
- **Azure Container Apps deployment:** Bicep, azd, Key Vault, managed identity, a distroless image published to GHCR, an Entra app registration script, and docs/AZURE.md.
- **Prompts:** fleet triage, patch review, device triage and connection check.
- **Ticketing:** `ninjaone_add_ticket_comment` posts internal notes only. `ninjaone_send_ticket_reply` sends public replies and sits in the destructive tier.
