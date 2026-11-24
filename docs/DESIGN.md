# Design

How ninja-one-mcp is put together, and why. The rules it follows are in [STANDARD.md](../STANDARD.md). This page covers the decisions specific to NinjaOne.

## Tools are data

NinjaOne's API has 315 operations. Writing 300 handlers by hand would mean writing the gate, the boundary, paging and read-back 300 times, and getting one of them wrong. So most tools are a `Route` in `src/routes/`: path, kind, scope, paging style, body and safety flags. `src/engine.ts` is the one place that turns a route into a tool. Every route-built tool runs the same steps in the same order:

1. **Gate** (in `defineTool`). A refusal happens before any request, including the lookups a tool would make to resolve its arguments.
2. **Scope.** Organization resolution, device boundary check, `df` narrowing, or refusal for what cannot be scoped.
3. **Request.** Path and query are built from validated arguments only.
4. **Before.** For writes with `readBack`, the record as it was.
5. **Dry run.** For wide writes, the exact request is returned unsent.
6. **Send.** With `noRetry` for actions that must never run twice.
7. **After.** The stored value, read back.
8. **Shape.** Compact fields, one cursor format, and short reads announced.

What is not one call lives in `src/tools/`. That covers composed reads (device profile, fleet health), the two endpoints the engine cannot express (a POST used as a read, a multipart comment), views and passthrough.

## Kinds

| Kind | Rule | Examples |
|---|---|---|
| read | Changes nothing. | lists, gets, reports, views |
| write | The API can undo it, or the tool returns the undo (`before`). | create, update, archive, restore, maintenance, patch scan |
| destructive | The API cannot give it back. | delete, reboot, script, patch apply, service control, full replacements, role removal, signed-URL downloads, raw writes |

Signed URLs and installer links are destructive-tier reads. A revealed secret cannot be un-revealed (STANDARD.md X4), so they need both gates plus `reveal: true`.

## Scope kinds

Every route declares how it is held inside `NINJAONE_ALLOWED_ORG_IDS`:

| Scope | Behavior under a boundary |
|---|---|
| `org` | The path carries an organization id. `org` resolves to an id, a name, or a refusal with candidates. |
| `orgFilter` | A query filter takes organization ids. Without `org`, it is forced to the allowed ids. |
| `device` | The path carries a device id. The device's organization is checked, and cached for 10 minutes. |
| `df` | ` AND org in (...)` is appended. NinjaOne filters only support AND, so this can only narrow. |
| `rows` | Rows carry an organization field. Rows outside the boundary are dropped and counted in a warning. |
| `account` | Account-wide configuration. Reads are allowed. Writes are refused under a boundary, because they affect every client. |
| `unscoped` | Addressed by an id the server cannot check. Refused under a boundary. |

Without a boundary, none of this costs an extra call. The device check only reads the device when a boundary is set.

## Paging

NinjaOne pages four ways. The engine hides all of them behind one opaque `cursor`, with `has_more` and `next_cursor` on every list:

| Upstream | Endpoints | Next page |
|---|---|---|
| `pageSize` + `after` (last id) | devices, organizations, locations | Last row's id, when the page came back full. |
| `pageSize` + `olderThan` (activity id) | activities | Lowest id on the page. |
| `pageSize` + `cursor` (cursor name) | `/v2/queries/*`, backup jobs | `cursor.name` from the response. |
| `after` + `pageInfo` | ITAM | `pageInfo.nextCursor` when `hasMore`. |
| none | most lists | Paged locally, so the model still sees `has_more`. |

An unrecognized response shape is an error, never zero rows.

## Auth

OAuth 2.0 client credentials against `https://{region}/ws/oauth/token`, with the credentials in a form body:

- The token is cached until a minute before it expires.
- Concurrent callers share one in-flight request.
- A 401 from the API drops the token and retries once.
- Each new token is registered with the redactor before it is used.
- There is no default region. A guess would send the credential to the wrong instance, and the error would look like a bad secret.

## Retries

- 429 means the request was not processed, so any method retries, honoring `Retry-After` up to 30 seconds.
- 5xx and network errors retry only for GET. A 5xx on a POST may have applied, and replaying it could create a ticket twice.
- Scripts, reboots, patch apply and service control set `noRetry` and never retry. A replayed reboot is worse than a failed one.

## Toolsets

The full surface is about 300 tools. VS Code with Copilot accepts 128 per request, Cursor warns past roughly 40, and smaller lists plan better anyway. Toolsets only decide what is listed: annotations never change with configuration (STANDARD.md A5), and the gate applies to whatever is listed. Hidden read tools stay callable internally, so views and composed tools keep working when their building blocks are not listed.

## Remote lane

The same server runs over Streamable HTTP on two lanes, built from the shared kit in [LANES.md](../LANES.md): `node dist/http/main.js` in the container ([deploy-azure.md](deploy-azure.md)) and a Cloudflare Worker ([deploy-cloudflare.md](deploy-cloudflare.md)). The decisions behind it:

- **Stateless.** No session ids. Every POST builds a fresh `McpServer`. Only deployment-level state is shared between requests: the NinjaOne token cache and the organization directory, both tied to the deployment's own API client. Nothing about a caller lives in module scope, so any replica or isolate can serve any request.
- **Fails closed.** Without `MCP_HTTP_AUTH` the container exits and the Worker answers 503. Shared tokens must be at least 32 characters and are compared in constant time.
- **Auth is the server's job.** Entra ID and Cloudflare Access tokens are validated in `src/remote/auth.ts` with jose, which runs unchanged on Node and Workers. Entra mode publishes RFC 9728 protected resource metadata and returns a `WWW-Authenticate` challenge pointing at it, so MCP clients can sign in on their own.
- **No token passthrough.** The caller's token proves who may use the server. NinjaOne is always called with the deployment's own client credentials.
- **Settings come from the deployment.** Gates, scopes, org boundary and toolsets are environment settings or wrangler vars. A caller cannot change them.
- **One handler, two runtimes.** `src/remote/handler.ts` is Request in, Response out. The Node lane adapts `node:http` to it; the Worker calls it directly. A refusal is written once and tested on both.
- **Deploys are manual and gated.** `deploy-azure.yml` (OpenID Connect, no stored Azure secret) and `deploy-cloudflare.yml` run on demand in GitHub environments, only when `DEPLOY_AZURE_ENABLED` or `DEPLOY_CLOUDFLARE_ENABLED` is `true`, and both finish with a smoke test that an unauthenticated `POST /mcp` answers 401.

## Distribution

One codebase ships four ways:

- `npx -y github:divergeitamplifyai/ninja-one-mcp`: `bin/` runs `dist/` when it is built, and the committed bundle otherwise, so a git install needs no build.
- `plugins/ninjaone/`: Claude Code (`.claude-plugin/plugin.json`, with `userConfig` and a keychain-stored secret) and Codex (portable `plugin.json` and `mcp.json`). Both run the same single-file bundle with plain `node`.
- `build/ninja-one-mcp.mcpb`: Claude Desktop, built from the same bundle.
- `Dockerfile`: the remote image. It builds from source and runs on distroless as non-root. Release tags publish it to GHCR and `azd up` builds it into your own registry. The Cloudflare Worker does not use the image: wrangler bundles `src/worker/index.ts`.
- The npm package, once published.

The bundle, the tool catalog, the coverage report and the generated body docs are committed. CI regenerates them and fails on drift.
