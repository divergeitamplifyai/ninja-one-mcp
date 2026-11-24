# Deploy to Azure Container Apps

Lane (d) of [LANES.md](../LANES.md): the server as a remote MCP endpoint on
Azure Container Apps, one URL for a whole team. Sign-in is Microsoft Entra ID,
the NinjaOne client id and secret live in Key Vault, and the same gates apply
as on a laptop. Committed defaults are read only.

```text
 MCP client (VS Code, Claude Code, ...)
   |  HTTPS  POST /mcp   Authorization: Bearer <Entra access token>
   v
 Container Apps ingress (TLS only, optional IP allow list)
   v
 container (distroless, non-root, scales to zero)
   1. validate the token: signature (tenant JWKS), issuer, audience, tenant, scope
   2. new MCP server for this request (stateless)
   3. gates and org boundary from deployment settings
   4. call NinjaOne with the deployment's API client, never the caller's token
   v
 NinjaOne Public API v2 (OAuth client credentials, token cached per deployment)

 Key Vault -- NinjaOne client id and secret, bearer token --> read by the app's managed identity
 Log Analytics <-- one JSON line per request (no tokens, no arguments)
```

## What gets deployed

`infra/main.bicep` creates the resource group `rg-<env>` with:

| Resource | Purpose |
|---|---|
| Container App `ca-mcp-*` | The server. External HTTPS ingress on port 8080, `allowInsecure: false`, `/healthz` probes, 0 to 3 replicas, 0.5 vCPU and 1 GiB. |
| Container Apps environment | Consumption profile, logs to Log Analytics. |
| User-assigned managed identity | Key Vault Secrets User on the vault, AcrPull on the registry. No passwords. |
| Key Vault (RBAC, purge protection) | `ninjaone-client-id`, `ninjaone-client-secret` and, in bearer mode, `mcp-bearer-token`. The app references them by URL. |
| Container registry (Basic) | Images azd builds remotely. Admin user off. |
| Log Analytics workspace | 30-day retention. |

## Trust boundaries

| Boundary | Threat | Control |
|---|---|---|
| Internet to ingress | Anonymous callers | Every `/mcp` request needs a valid token, or 401 with a `resource_metadata` challenge. `/healthz` and the metadata reveal nothing. Optional `allowedIpRanges`. |
| Caller to server | Forged or stolen token | RS256 signature from the tenant JWKS; issuer, `tid` and audience must be this tenant and this app; `exp` and `nbf` with 60 s skew; `mcp.access` scope or a configured app role. Require user assignment on the enterprise app to limit who can get a token. |
| Caller to server | Browser CSRF, DNS rebinding | Any `Origin` must be on `MCP_ALLOWED_ORIGINS`. |
| Server to NinjaOne | Token passthrough | The caller's token is dropped at the door; NinjaOne is called with the deployment's API client. Every signed-in user acts as that one identity, so grant the API client only the `monitoring` scope unless writes are intended, and set `NINJAONE_ALLOWED_ORG_IDS` where you can. |
| Secrets at rest | Sprawl | Secrets arrive as secure parameters and land in Key Vault only, never in app settings, the image, or logs. |
| Supply chain | Tampered image | Built from the lockfile, digest-pinned bases, distroless runtime, non-root. |

## Deploy from your machine

Prerequisites: `az` and `azd`, rights to create resource groups and role
assignments, and rights to create an Entra app registration.

```bash
az login
azd auth login
azd env new <env-name>
azd env set AZURE_LOCATION <region>

# Entra app registration that protects /mcp. Saves MCP_HTTP_AUTH and MCP_ENTRA_CLIENT_ID.
infra/scripts/entra-app.sh "NinjaOne MCP"

# NinjaOne API client (Administration > Apps > API, client credentials grant).
# azd keeps Key Vault references, not the values.
azd env set-secret NINJAONE_CLIENT_ID
azd env set-secret NINJAONE_CLIENT_SECRET
azd env set NINJAONE_REGION us                 # us, us2, eu, ca or oc

# Optional
azd env set NINJAONE_ALLOWED_ORG_IDS 101,102   # hard boundary
azd env set NINJAONE_TOOLSETS all              # default lists the core toolsets
azd env set MCP_MIN_REPLICAS 1                 # no cold start

azd up
curl -s "$(azd env get-value MCP_URL | sed 's#/mcp$##')/healthz"
curl -s "$(azd env get-value MCP_URL | sed 's#/mcp$##')/.well-known/oauth-protected-resource"
```

The first provision runs a placeholder image until `azd deploy` pushes the real
one; with zero minimum replicas it serves nothing in between.

### Shared token instead of Entra

For clients that cannot do OAuth:

```bash
azd env set MCP_HTTP_AUTH bearer
azd env set-secret MCP_BEARER_TOKEN   # paste the output of: openssl rand -base64 48
azd up
```

Tokens under 32 characters stop the container at startup. Rotate by setting a
comma-separated pair (new, old) and running `azd provision`, then drop the old
one. Entra is the better default: per user, revocable, no shared secret.

## Deploy from GitHub Actions

`.github/workflows/deploy-azure.yml` does nothing until the repository variable
`DEPLOY_AZURE_ENABLED` is `true`. Then it runs by hand only (Actions > Deploy to
Azure), from `main`, in the GitHub environment `azure`, and signs in with
OpenID Connect: no Azure secret is stored in GitHub.

Run `azd up` once from a machine first. Then create the deploying identity and
trust the `azure` environment of this repository:

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

Contributor on the resource group deploys images. Provisioning also creates
role assignments, so it needs Owner, or Contributor plus Role Based Access
Control Administrator, at subscription scope.

| Kind | Name | Notes |
|---|---|---|
| Repository variable | `DEPLOY_AZURE_ENABLED` | `true` turns the workflow on. |
| Environment variable | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` | The deploying identity. |
| Environment variable | `AZURE_ENV_NAME`, `AZURE_LOCATION` | Same as the azd environment. |
| Environment variable (optional) | `NINJAONE_REGION`, `NINJAONE_SCOPES`, `NINJAONE_TOOLSETS`, `NINJAONE_MODE`, `NINJAONE_ALLOW_DESTRUCTIVE`, `NINJAONE_ALLOWED_ORG_IDS`, `MCP_HTTP_AUTH`, `MCP_ENTRA_CLIENT_ID`, `MCP_ENTRA_APP_ID_URI`, `MCP_ALLOWED_ORIGINS`, `MCP_MIN_REPLICAS` | Applied when `provision` is ticked. Unset means `us`, `monitoring`, read only, Entra, scale to zero. |
| Environment secret | `NINJAONE_CLIENT_ID`, `NINJAONE_CLIENT_SECRET`, `MCP_BEARER_TOKEN` (bearer mode) | Read only when `provision` is ticked; provisioning rewrites the Key Vault secrets. |

The run ends by checking `/healthz` and that `POST /mcp` without a token
answers 401.

## Connect clients

VS Code finds the sign-in from the metadata document:

```json
{ "servers": { "ninjaone": { "type": "http", "url": "https://<app>.<region>.azurecontainerapps.io/mcp" } } }
```

Claude Code:

```bash
claude mcp add --transport http ninjaone https://<app>.<region>.azurecontainerapps.io/mcp
```

Entra has no dynamic client registration. If a client cannot sign in, register
a public client for it and pre-authorize it on the `mcp.access` scope the way
`entra-app.sh` does for VS Code, or use bearer mode with
`--header "Authorization: Bearer <token>"`.

Claude Desktop and claude.ai custom connectors need OAuth with client
registration, which Entra does not offer. Use the local `.mcpb` bundle for
Claude Desktop instead.

## Operate

- Logs: Log Analytics, table `ContainerAppConsoleLogs_CL`. Events:
  `http_request` (caller subject, status, ms), `http_auth_refused`,
  `http_origin_refused`, `write_refused`, `write_applied`.
- Open writes: grant the API client the `management` scope in NinjaOne, set
  `NINJAONE_SCOPES` and `NINJAONE_MODE=write` in the azd environment (or the
  GitHub environment) and provision. Close them the same way.
- Roll back: `az containerapp revision list -n <app> -g rg-<env>` and
  `az containerapp ingress traffic set -n <app> -g rg-<env> --revision-weight <old-revision>=100`,
  or redeploy the previous commit.
- Rotate the NinjaOne secret: create a new one in NinjaOne, set it with
  `azd env set-secret NINJAONE_CLIENT_SECRET`, provision, then delete the old
  one in NinjaOne.
- Remove everything: `azd down --purge`. Purge protection keeps the vault name
  reserved for 30 days. Delete the app registration separately.

## Settings reference

The image sets `MCP_HTTP_HOST=0.0.0.0` and `MCP_HTTP_PORT=8080`; Bicep sets the
rest from the azd environment. Names and meanings are the same in every lane
(LANES.md, section 3).

| Variable | Set from | Meaning |
|---|---|---|
| `NINJAONE_CLIENT_ID`, `NINJAONE_CLIENT_SECRET` | Key Vault (`azd env set-secret`) | The NinjaOne API client. |
| `NINJAONE_REGION` | azd env, default `us` | Instance: `us`, `us2`, `eu`, `ca`, `oc`. |
| `NINJAONE_SCOPES` | azd env, default `monitoring` | OAuth scopes requested. |
| `NINJAONE_TOOLSETS` | azd env, default `default` | Toolsets listed. |
| `NINJAONE_MODE`, `NINJAONE_ALLOW_DESTRUCTIVE` | azd env, default `read`, `false` | The two write gates. |
| `NINJAONE_ALLOWED_ORG_IDS` | azd env | Hard organization boundary. |
| `MCP_HTTP_AUTH` | azd env, default `entra` | `entra` or `bearer`. Unset or anything else stops the container. |
| `MCP_PUBLIC_URL` | Bicep | The app's https origin, the RFC 9728 `resource`. |
| `MCP_ENTRA_TENANT_ID` | Bicep | The subscription's tenant. |
| `MCP_ENTRA_CLIENT_ID`, `MCP_ENTRA_APP_ID_URI` | azd env (`entra-app.sh`) | The MCP app registration. |
| `MCP_ENTRA_SCOPE`, `MCP_ENTRA_ROLE` | not set by Bicep | Defaults `mcp.access` and none (app-only tokens refused). |
| `MCP_BEARER_TOKEN` | Key Vault | Bearer mode: 32+ characters, comma separate two while rotating. |
| `MCP_ALLOWED_ORIGINS` | azd env | Browser origins allowed to call `/mcp`. |

## Run the image locally

```bash
docker build -t ninja-one-mcp .
docker run --rm -p 8080:8080 \
  -e MCP_HTTP_AUTH=bearer -e MCP_BEARER_TOKEN="$(openssl rand -base64 48)" \
  -e NINJAONE_REGION=us -e NINJAONE_CLIENT_ID=... -e NINJAONE_CLIENT_SECRET=... \
  ninja-one-mcp
```

Without Docker, `MCP_HTTP_AUTH=none npm run start:http` listens on
`127.0.0.1:8080` with no inbound auth. That is allowed on loopback only.
