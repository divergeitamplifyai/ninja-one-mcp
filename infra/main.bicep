// Azure Container Apps lane (LANES.md, docs/deploy-azure.md).
//
// One resource group: Log Analytics, a user-assigned managed identity, Key Vault
// (RBAC) holding the NinjaOne client id and secret and the optional bearer token, a
// container registry, a Container Apps environment, and the app (HTTPS-only
// ingress, scale to zero, auth enforced by the server).
//
// Deploy with `azd up`. Nothing here holds a secret in plain text: secrets
// arrive as secure parameters and land in Key Vault. Tenant and subscription
// come from the signed-in deployment, never from a committed value.

targetScope = 'subscription'

@minLength(1)
@maxLength(40)
@description('azd environment name; names the resource group and resources.')
param environmentName string

@minLength(1)
@description('Azure region for every resource.')
param location string

@description('NinjaOne instance (NINJAONE_REGION): us, us2, eu, ca or oc.')
@allowed(['us', 'us2', 'eu', 'ca', 'oc'])
param region string = 'us'

@secure()
@minLength(1)
@description('NinjaOne API client id (NINJAONE_CLIENT_ID). Stored in Key Vault only.')
param clientId string

@secure()
@minLength(1)
@description('NinjaOne API client secret (NINJAONE_CLIENT_SECRET). Stored in Key Vault only.')
param clientSecret string

@description('OAuth scopes to request (NINJAONE_SCOPES). monitoring is read only.')
param scopes string = 'monitoring'

@description('Toolsets to list (NINJAONE_TOOLSETS): default, all, or a list.')
param toolsets string = 'default'

@description('Write gate (NINJAONE_MODE). read refuses every change.')
@allowed(['read', 'write'])
param mode string = 'read'

@description('Second gate for the destructive tier (NINJAONE_ALLOW_DESTRUCTIVE). Needs mode = write.')
@allowed(['false', 'true'])
param allowDestructive string = 'false'

@description('Optional hard boundary: comma-separated organization ids (NINJAONE_ALLOWED_ORG_IDS).')
param allowedOrgIds string = ''

@description('Inbound auth for /mcp (MCP_HTTP_AUTH): entra (recommended) or bearer.')
@allowed(['entra', 'bearer'])
param inboundAuth string = 'entra'

@description('Entra mode: client id of the MCP server app registration (infra/scripts/entra-app.sh creates it).')
param entraClientId string = ''

@description('Entra mode: Application ID URI. Empty means api://<entraClientId>.')
param entraAppIdUri string = ''

@secure()
@description('Bearer mode: shared token, at least 32 characters (openssl rand -base64 48).')
param bearerToken string = ''

@description('Browser origins allowed to call /mcp (MCP_ALLOWED_ORIGINS). Empty allows none.')
param allowedOrigins string = ''

@description('Optional inbound IP allow list (CIDR). Empty allows any source; auth still applies.')
param allowedIpRanges array = []

@description('Minimum replicas. 0 scales to zero when idle (a cold start on the first call).')
@minValue(0)
param minReplicas int = 0

@description('Maximum replicas.')
@minValue(1)
param maxReplicas int = 3

@description('Set by azd: true once the container app exists, so provision keeps the deployed image.')
param mcpExists bool = false

var tags = { 'azd-env-name': environmentName }
var token = toLower(uniqueString(subscription().id, environmentName, location))

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-${environmentName}'
  location: location
  tags: tags
}

module resources 'modules/resources.bicep' = {
  name: 'mcp-resources'
  scope: rg
  params: {
    location: location
    tags: tags
    token: token
    tenantId: subscription().tenantId
    region: region
    clientId: clientId
    clientSecret: clientSecret
    scopes: scopes
    toolsets: toolsets
    mode: mode
    allowDestructive: allowDestructive
    allowedOrgIds: allowedOrgIds
    inboundAuth: inboundAuth
    entraClientId: entraClientId
    entraAppIdUri: entraAppIdUri
    bearerToken: bearerToken
    allowedOrigins: allowedOrigins
    allowedIpRanges: allowedIpRanges
    minReplicas: minReplicas
    maxReplicas: maxReplicas
    mcpExists: mcpExists
  }
}

output AZURE_RESOURCE_GROUP string = rg.name
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = resources.outputs.registryLoginServer
output AZURE_KEY_VAULT_NAME string = resources.outputs.keyVaultName
output SERVICE_MCP_NAME string = resources.outputs.appName
output MCP_URL string = resources.outputs.mcpUrl
