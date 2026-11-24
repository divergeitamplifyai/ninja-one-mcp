// ninja-one-mcp on Azure Container Apps.
//
// One resource group holding: Log Analytics, a user-assigned managed identity,
// Key Vault (RBAC) with the NinjaOne client secret, a container registry, a
// Container Apps environment, and the app itself (Streamable HTTP, min one
// replica, Entra ID or shared-token auth enforced by the server).
//
// Deploy with `azd up` (see docs/AZURE.md). Nothing here holds a secret value
// in plain text: secrets arrive as secure parameters and land in Key Vault.

targetScope = 'subscription'

@minLength(1)
@maxLength(40)
@description('azd environment name; used to name the resource group and resources.')
param environmentName string

@minLength(1)
@description('Azure region for every resource.')
param location string

@description('NinjaOne region of the API client: us, us2, eu, ca or oc.')
@allowed(['us', 'us2', 'eu', 'ca', 'oc'])
param ninjaRegion string = 'us'

@description('NinjaOne API client id (Administration > Apps > API).')
param ninjaClientId string

@secure()
@description('NinjaOne API client secret. Stored in Key Vault only.')
param ninjaClientSecret string

@description('OAuth scopes to request from NinjaOne. Keep monitoring only unless writes are intended.')
param ninjaScopes string = 'monitoring'

@description('Write gate. read refuses every change.')
@allowed(['read', 'write'])
param ninjaMode string = 'read'

@description('Second gate for the destructive tier. Needs ninjaMode = write.')
@allowed(['false', 'true'])
param ninjaAllowDestructive string = 'false'

@description('Optional hard boundary: comma-separated NinjaOne organization ids.')
param ninjaAllowedOrgIds string = ''

@description('Toolsets to list: default, all, or a list.')
param ninjaToolsets string = 'default'

@description('Inbound auth for the MCP endpoint: entra (recommended) or bearer.')
@allowed(['entra', 'bearer'])
param inboundAuth string = 'entra'

@description('Entra mode: client id of the MCP server app registration (infra/scripts/entra-app.sh creates it).')
param entraClientId string = ''

@description('Entra mode: Application ID URI. Defaults to api://<entraClientId>.')
param entraAppIdUri string = ''

@secure()
@description('Bearer mode: shared token, at least 32 characters (openssl rand -base64 48). Required when inboundAuth = bearer.')
param bearerToken string = ''

@description('Optional inbound IP allowlist (CIDR). Empty allows any source; auth still applies.')
param allowedIpRanges array = []

@description('Browser origins allowed to call the MCP endpoint (for web-based clients).')
param allowedOrigins string = ''

@description('Container image. Empty uses the image azd builds and pushes to the registry.')
param containerImage string = ''

@description('Minimum replicas. 1 avoids cold starts for interactive clients.')
@minValue(0)
param minReplicas int = 1

@description('Maximum replicas.')
@minValue(1)
param maxReplicas int = 3

var tags = { 'azd-env-name': environmentName, app: 'ninja-one-mcp' }
var token = toLower(uniqueString(subscription().id, environmentName, location))

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-${environmentName}'
  location: location
  tags: tags
}

module resources 'modules/resources.bicep' = {
  name: 'ninja-one-mcp-resources'
  scope: rg
  params: {
    location: location
    tags: tags
    token: token
    ninjaRegion: ninjaRegion
    ninjaClientId: ninjaClientId
    ninjaClientSecret: ninjaClientSecret
    ninjaScopes: ninjaScopes
    ninjaMode: ninjaMode
    ninjaAllowDestructive: ninjaAllowDestructive
    ninjaAllowedOrgIds: ninjaAllowedOrgIds
    ninjaToolsets: ninjaToolsets
    inboundAuth: inboundAuth
    tenantId: subscription().tenantId
    entraClientId: entraClientId
    entraAppIdUri: entraAppIdUri
    bearerToken: bearerToken
    allowedIpRanges: allowedIpRanges
    allowedOrigins: allowedOrigins
    containerImage: containerImage
    minReplicas: minReplicas
    maxReplicas: maxReplicas
  }
}

output AZURE_RESOURCE_GROUP string = rg.name
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = resources.outputs.registryLoginServer
output AZURE_KEY_VAULT_NAME string = resources.outputs.keyVaultName
output MCP_URL string = resources.outputs.mcpUrl
output SERVICE_MCP_NAME string = resources.outputs.appName
