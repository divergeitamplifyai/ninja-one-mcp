# Deploy to Azure

Run ninja-one-mcp as a remote MCP server on **Azure Container Apps**, so a team can connect to one endpoint without installing anything. Sign-in is Microsoft Entra ID, the NinjaOne secret lives in Key Vault, and the same safety gates apply as on a laptop. To run the same image on Cloudflare instead, see [CLOUDFLARE.md](CLOUDFLARE.md).

```text
 MCP client (VS Code, Claude Code, Cursor, ...)
   │  HTTPS  POST /mcp   Authorization: Bearer <Entra access token>
   ▼
 Azure Container Apps ingress (TLS, optional IP allowlist)
   ▼
 ninja-one-mcp container (distroless, non-root, min 1 replica)
   │  1. validate the Entra token (signature, issuer, audience, expiry, scope)
   │  2. new MCP server for this request (stateless)
   │  3. gates, org boundary and toolsets from deployment settings
   │  4. call NinjaOne with the deployment's own OAuth client (never the caller's token)
   ▼
 NinjaOne Public API v2 (app/us2/eu/ca/oc.ninjarmm.com)

 Key Vault ── NinjaOne client secret ──▶ read by the app's managed identity
 Log Analytics ◀── structured logs (no tokens, no arguments)
```

## Why Container Apps

Microsoft documents five ways to host an MCP server on Azure. Container Apps (standalone) fits this server best:

| Need | Container Apps | Why not the others |
|---|---|---|
| A custom server built on the official SDK | Yes, any container | Dynamic sessions only run Microsoft's built-in code tools. |
| Streamable HTTP, stateless | Yes, it is just HTTPS ingress | Functions maps tools to triggers and does not run `npx`, so this server would need rewriting. |
| Secrets without code | Key Vault references through a managed identity | App Service can do this too, but needs a plan and offers no scale-to-zero option. |
| Low operations | Managed, no cluster | AKS means running a cluster. Only worth it if you already have one. |
| Interactive latency | Minimum one replica, no cold start | Functions on the Consumption plan has cold starts. |
| The same artifact everywhere | The image CI builds and tests | Built-in MCP on App Service would expose raw OpenAPI operations without this server's gates. |

Microsoft's own guidance ([Choose an Azure service for your MCP server](https://learn.microsoft.com/azure/container-apps/mcp-choosing-azure-service)) starts here too: "Not sure where to start? Begin with Azure Container Apps (standalone)."

Authentication is validated **inside the server**, not by Container Apps' built-in auth. The MCP authorization spec requires a public protected-resource metadata document and a `WWW-Authenticate` challenge that points to it. Built-in auth in `Return401` mode has no documented way to leave the metadata path open. In-app validation needs no extra dependency: tokens are checked with `node:crypto` against the tenant's JWKS.

## What gets deployed

`infra/main.bicep` creates one resource group, `rg-<env>`, containing:

| Resource | Purpose | Notes |
|---|---|---|
| Container App `ca-ninjaone-*` | The server | External HTTPS ingress, port 8080, `/healthz` probes, 1 to 3 replicas, 0.5 vCPU and 1 GiB. |
| Container Apps environment | Hosting | Consumption workload profile. Logs go to Log Analytics. |
| User-assigned managed identity | The app's identity | Has Key Vault Secrets User on the vault and AcrPull on the registry. No passwords. |
| Key Vault (RBAC) | NinjaOne client secret and the optional bearer token | Soft delete and purge protection are on. The app references secrets by URL. |
| Container registry (Basic) | Images that azd builds | Admin user off; pulls use the managed identity. |
| Log Analytics workspace | Logs | 30-day retention. |

All values the server reads are deployment settings, never caller input: gates, scopes, org boundary and toolsets.

## Trust boundaries and abuse cases

| Boundary | Threat | Control |
|---|---|---|
| Internet to ingress | Anonymous callers | Every `/mcp` request needs a valid token. Without one the server answers 401 with the metadata challenge. `/healthz` and the metadata document reveal nothing. An optional IP allowlist (`allowedIpRanges`) blocks traffic at the ingress. |
| Caller to server | A stolen or forged token | RS256 signature checked against the tenant JWKS. Issuer and `tid` must be your tenant, audience must be this app, `exp` and `nbf` hold with 2 minutes of skew, and the `mcp.access` scope (or a configured app role) is required. Requiring user assignment on the enterprise app limits who can get a token at all. |
| Caller to server | Browser-based CSRF or DNS rebinding | Any request with an `Origin` header must match `MCP_ALLOWED_ORIGINS`. Desktop clients send no Origin. |
| Server to NinjaOne | Token passthrough or a confused deputy | The caller's token is never forwarded. NinjaOne is called with the deployment's client credentials, so every signed-in user acts as that one NinjaOne API client. Limit the blast radius with scopes, gates and the org boundary below. |
| Server to NinjaOne | Too much power | Grant the NinjaOne API client `monitoring` only for a read-only deployment. Keep `ninjaMode=read` unless writes are intended. Use `ninjaAllowedOrgIds` to pin a deployment to specific clients. |
| Secrets at rest | Secret sprawl | The NinjaOne secret goes into Key Vault as a secure parameter. It is never in an app setting, an image or a log. Redaction covers results, errors and logs. |
| Supply chain | Tampered image | The image is built from source in CI with digest-pinned bases, a distroless runtime, a non-root user and no shell. |

One limitation to know: every signed-in user shares the deployment's NinjaOne identity. For per-person NinjaOne permissions, run separate deployments with different API clients and gates (a read-only one for the whole team, a write-enabled one for a few people), or use the local stdio server with each person's own API client.

## Deploy

### Prerequisites

- An Azure subscription where you can create resource groups and role assignments.
- Rights to create an app registration in Microsoft Entra ID.
- [Azure Developer CLI](https://learn.microsoft.com/azure/developer/azure-developer-cli/install-azd) (`azd`) and [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) (`az`).
- A NinjaOne API client: platform API Services, grant Client Credentials, scope `monitoring` (see the README).

### 1. Sign in and create an environment

```bash
az login
azd auth login
azd env new ninjaone-prod
azd env set AZURE_LOCATION eastus2
```

### 2. Register the Entra app

```bash
infra/scripts/entra-app.sh "NinjaOne MCP"
```

This creates a single-tenant app with the Application ID URI `api://<client-id>` and a delegated scope `mcp.access`, requests v2 tokens, and pre-authorizes VS Code. It stores the client id in the azd environment. Then restrict sign-in to people you choose:

```bash
az ad sp update --id <client-id> --set appRoleAssignmentRequired=true
```

Assign users or a group under **Entra ID > Enterprise applications > NinjaOne MCP > Users and groups**.

### 3. Give it the NinjaOne credentials

```bash
azd env set NINJAONE_REGION us
azd env set NINJAONE_CLIENT_ID <ninjaone-client-id>
azd env set-secret NINJAONE_CLIENT_SECRET
```

`azd env set-secret` keeps only a Key Vault reference in the azd environment, never the value in plain text in `.azure/`. At provision time the value is passed as a secure parameter and written into the deployment's own Key Vault.

Optional settings:

```bash
azd env set NINJAONE_ALLOWED_ORG_IDS 12,15         # hard boundary to these clients
azd env set NINJAONE_TOOLSETS default,documentation
azd env set NINJAONE_MODE write                    # only if writes are intended
azd env set NINJAONE_SCOPES "monitoring management"
```

### 4. Deploy

```bash
azd up
```

azd provisions the resources, builds the image in your registry, deploys it, and prints `MCP_URL`. Check it:

```bash
curl -s "$(azd env get-value MCP_URL | sed 's#/mcp$##')/healthz"
curl -s "$(azd env get-value MCP_URL | sed 's#/mcp$##')/.well-known/oauth-protected-resource"
```

### Alternative: shared token instead of Entra

For clients that cannot do OAuth, or a quick private deployment:

```bash
azd env set MCP_INBOUND_AUTH bearer
azd env set-secret MCP_BEARER_TOKEN    # paste the output of: openssl rand -base64 48
azd up
```

Clients then send `Authorization: Bearer <token>`. Tokens must be at least 32 characters. Rotate by setting a new value and running `azd provision`. Entra is the better default, because it is per user, revocable, and needs no shared secret.

## Deploy from GitHub Actions

`.github/workflows/deploy-azure.yml` deploys a chosen tag or branch by hand (Actions > Deploy to Azure > Run workflow). It signs in to Azure with OpenID Connect, so no Azure secret is stored in GitHub, and runs in the GitHub environment `azure`; add required reviewers there to gate every run.

First run `azd up` once from your machine (above). Then create the deploying identity and trust this repository's `azure` environment:

```bash
APP_ID=$(az ad app create --display-name "ninja-one-mcp deploy" --query appId -o tsv)
az ad sp create --id "$APP_ID"
az ad app federated-credential create --id "$APP_ID" --parameters '{
  "name": "github-azure-environment",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:<owner>/ninja-one-mcp:environment:azure",
  "audiences": ["api://AzureADTokenExchange"]
}'
az role assignment create --assignee "$APP_ID" --role Contributor --scope "/subscriptions/<subscription-id>/resourceGroups/rg-<env>"
```

Contributor on the resource group is enough to deploy new images. To let the workflow provision as well (it creates role assignments and the resource group), grant Owner, or Contributor plus Role Based Access Control Administrator, on the subscription instead.

| Kind | Name | Value |
|---|---|---|
| Variable | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` | The deploying identity. |
| Variable | `AZURE_ENV_NAME`, `AZURE_LOCATION` | The same values as your azd environment, e.g. `ninjaone-prod` and `eastus2`. |
| Variable (optional) | `NINJAONE_REGION`, `NINJAONE_CLIENT_ID`, `NINJAONE_SCOPES`, `NINJAONE_MODE`, `NINJAONE_ALLOW_DESTRUCTIVE`, `NINJAONE_ALLOWED_ORG_IDS`, `NINJAONE_TOOLSETS`, `MCP_INBOUND_AUTH`, `MCP_ENTRA_CLIENT_ID`, `MCP_ENTRA_APP_ID_URI`, `MCP_ALLOWED_ORIGINS`, `MCP_MIN_REPLICAS` | Used when `provision` is ticked. |
| Secret | `NINJAONE_CLIENT_SECRET`, `MCP_BEARER_TOKEN` (bearer mode) | Needed only when `provision` is ticked. Provisioning rewrites the Key Vault secret with this value. |

Without `provision`, the workflow loads the outputs of the last provision, builds and deploys the image, and checks `/healthz` and that `POST /mcp` without a token answers 401. With it, it also applies `infra/` and the settings first.

## Connect clients

**VS Code / GitHub Copilot.** VS Code finds the sign-in from the metadata document and prompts you with Microsoft:

```json
{
  "servers": {
    "ninjaone": { "type": "http", "url": "https://<app>.<region>.azurecontainerapps.io/mcp" }
  }
}
```

**Claude Code.**

```bash
claude mcp add --transport http ninjaone https://<app>.<region>.azurecontainerapps.io/mcp
```

Claude Code runs the OAuth flow on first use. Entra has no dynamic client registration, so if sign-in fails, register a public client app for Claude Code in Entra and pre-authorize it like VS Code, or use bearer mode with a header:

```bash
claude mcp add --transport http ninjaone https://.../mcp --header "Authorization: Bearer <token>"
```

**Cursor and other clients.** Use the URL, plus an `Authorization` header in bearer mode.

**Claude Desktop and claude.ai custom connectors.** These need OAuth with client registration, which Entra does not offer. Use the local `.mcpb` bundle for Claude Desktop instead. A remote deployment for claude.ai would need an OAuth authorization server in front, which this lane does not include.

## Operate

**Logs.** In Log Analytics:

```kusto
ContainerAppConsoleLogs_CL
| where ContainerAppName_s startswith "ca-ninjaone"
| extend e = parse_json(Log_s)
| project TimeGenerated, level = tostring(e.level), event = tostring(e.event), caller = tostring(e.caller), status = toint(e.status), ms = toint(e.ms)
| order by TimeGenerated desc
```

Events:

- `http_request`: the caller's subject and the latency.
- `http_auth_refused`: the reason a request was refused.
- `write_applied` and `write_refused`: the tool name and kind, never arguments.

**Update.** Run `azd deploy` after a new release, or `azd up` after changing settings.

**Roll back.** Container Apps keeps revisions. Reactivate the previous one:

```bash
az containerapp revision list -n <app> -g rg-<env> -o table
az containerapp ingress traffic set -n <app> -g rg-<env> --revision-weight <previous-revision>=100
```

**Rotate the NinjaOne secret.** Create a new secret in NinjaOne, then `azd env set-secret NINJAONE_CLIENT_SECRET` and `azd provision`. A new revision picks it up. Delete the old secret in NinjaOne afterwards.

**Scale.** The server is stateless, so replicas scale on concurrent HTTP requests (50 per replica, 1 to 3 replicas). Set `MCP_MIN_REPLICAS=0` for scale to zero if a cold start of a few seconds is acceptable.

**Cost.** You pay for the container (one always-on replica of 0.5 vCPU and 1 GiB at the idle rate, plus active usage), a Basic registry, Key Vault operations and Log Analytics ingestion. Estimate them for your region with the [Azure pricing calculator](https://azure.microsoft.com/pricing/calculator/).

## Remove

```bash
azd down
```

Key Vault has purge protection, so the vault stays soft-deleted for 30 days and its name cannot be reused until then. Delete the app registration separately:

```bash
az ad app delete --id <client-id>
```

## Settings reference (remote)

| Variable | Set by | Meaning |
|---|---|---|
| `NINJAONE_TRANSPORT` | image | `http`. The `--http` flag does the same. |
| `NINJAONE_HTTP_HOST` / `NINJAONE_HTTP_PORT` | image | `0.0.0.0` / `8080` in the container. The default outside a container is `127.0.0.1`. |
| `NINJAONE_HTTP_AUTH` | `MCP_INBOUND_AUTH` | `entra` or `bearer`. `none` works only on loopback; anything else refuses to start. |
| `NINJAONE_HTTP_ENTRA_TENANT_ID` | Bicep | Your tenant. |
| `NINJAONE_HTTP_ENTRA_CLIENT_ID` | `MCP_ENTRA_CLIENT_ID` | The MCP app registration. |
| `NINJAONE_HTTP_ENTRA_APP_ID_URI` | `MCP_ENTRA_APP_ID_URI` | Defaults to `api://<client-id>`. |
| `NINJAONE_HTTP_ENTRA_SCOPE` | | Required delegated scope, default `mcp.access`. |
| `NINJAONE_HTTP_ENTRA_ROLE` | | Optional app role. Needed to accept app-only tokens. |
| `NINJAONE_HTTP_BEARER_TOKENS` | Key Vault | Bearer mode: comma-separated tokens of 32 or more characters. |
| `NINJAONE_HTTP_PUBLIC_URL` | Bicep | Used in the metadata document. |
| `NINJAONE_HTTP_ALLOWED_ORIGINS` | `MCP_ALLOWED_ORIGINS` | Browser origins allowed to call. |
| `NINJAONE_*` (everything else) | azd env | Same meaning as in the README. |

## Run the image locally

```bash
docker build -t ninja-one-mcp .
docker run --rm -p 8080:8080 \
  -e NINJAONE_HTTP_AUTH=bearer -e NINJAONE_HTTP_BEARER_TOKENS="$(openssl rand -base64 48)" \
  -e NINJAONE_REGION=us -e NINJAONE_CLIENT_ID=... -e NINJAONE_CLIENT_SECRET=... \
  ninja-one-mcp
```

Or without Docker: `NINJAONE_TRANSPORT=http npx -y github:divergeitamplifyai/ninja-one-mcp` listens on `127.0.0.1:8080` with no inbound auth. That is allowed on loopback only.
