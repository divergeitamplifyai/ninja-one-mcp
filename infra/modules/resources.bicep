// Everything inside the resource group. Parameters are described in ../main.bicep.

param location string
param tags object
param token string
param tenantId string
param region string
@secure()
param clientId string
@secure()
param clientSecret string
param scopes string
param toolsets string
param mode string
param allowDestructive string
param allowedOrgIds string
param inboundAuth string
param entraClientId string
param entraAppIdUri string
@secure()
param bearerToken string
param allowedOrigins string
param allowedIpRanges array
param minReplicas int
param maxReplicas int
param mcpExists bool

var appName = 'ca-mcp-${take(token, 20)}'
// Built-in role definition ids.
var keyVaultSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'
var acrPull = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
// Shown until the first `azd deploy` pushes the real image. Scale to zero means
// it never serves traffic on the app's port.
var placeholderImage = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-mcp-${token}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-mcp-${token}'
  location: location
  tags: tags
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'kv-mcp-${take(token, 17)}'
  location: location
  tags: tags
  properties: {
    tenantId: tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 30
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
  }
}

resource clientIdSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'ninjaone-client-id'
  properties: { value: clientId, contentType: 'NinjaOne API client id' }
}

resource clientSecretSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'ninjaone-client-secret'
  properties: { value: clientSecret, contentType: 'NinjaOne API client secret' }
}

resource bearerSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (inboundAuth == 'bearer') {
  parent: vault
  name: 'mcp-bearer-token'
  properties: { value: bearerToken, contentType: 'Shared bearer token for /mcp' }
}

resource vaultAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, identity.id, keyVaultSecretsUser)
  scope: vault
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUser)
  }
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: 'crmcp${take(token, 20)}'
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}

resource registryPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, identity.id, acrPull)
  scope: registry
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPull)
  }
}

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-mcp-${token}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
  }
}

resource existingApp 'Microsoft.App/containerApps@2024-03-01' existing = if (mcpExists) {
  name: appName
}

var publicUrl = 'https://${appName}.${env.properties.defaultDomain}'
var appIdUri = empty(entraAppIdUri) ? 'api://${entraClientId}' : entraAppIdUri

var baseEnv = [
  { name: 'NINJAONE_CLIENT_ID', secretRef: 'ninjaone-client-id' }
  { name: 'NINJAONE_CLIENT_SECRET', secretRef: 'ninjaone-client-secret' }
  { name: 'NINJAONE_REGION', value: region }
  { name: 'NINJAONE_SCOPES', value: scopes }
  { name: 'NINJAONE_TOOLSETS', value: toolsets }
  { name: 'NINJAONE_MODE', value: mode }
  { name: 'NINJAONE_ALLOW_DESTRUCTIVE', value: allowDestructive }
  { name: 'NINJAONE_ALLOWED_ORG_IDS', value: allowedOrgIds }
  { name: 'NINJAONE_ENV_FILE', value: 'none' }
  { name: 'MCP_HTTP_AUTH', value: inboundAuth }
  { name: 'MCP_PUBLIC_URL', value: publicUrl }
  { name: 'MCP_ALLOWED_ORIGINS', value: allowedOrigins }
]
var entraEnv = [
  { name: 'MCP_ENTRA_TENANT_ID', value: tenantId }
  { name: 'MCP_ENTRA_CLIENT_ID', value: entraClientId }
  { name: 'MCP_ENTRA_APP_ID_URI', value: appIdUri }
]
var bearerEnv = [{ name: 'MCP_BEARER_TOKEN', secretRef: 'mcp-bearer-token' }]

var baseSecrets = [
  { name: 'ninjaone-client-id', keyVaultUrl: clientIdSecret.properties.secretUri, identity: identity.id }
  { name: 'ninjaone-client-secret', keyVaultUrl: clientSecretSecret.properties.secretUri, identity: identity.id }
]
var bearerSecrets = inboundAuth == 'bearer'
  ? [{ name: 'mcp-bearer-token', keyVaultUrl: '${vault.properties.vaultUri}secrets/mcp-bearer-token', identity: identity.id }]
  : []

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  tags: union(tags, { 'azd-service-name': 'mcp' })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  dependsOn: [vaultAccess, registryPull, bearerSecret]
  properties: {
    environmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'http'
        allowInsecure: false
        ipSecurityRestrictions: [for (cidr, i) in allowedIpRanges: {
          name: 'allow-${i}'
          action: 'Allow'
          ipAddressRange: cidr
        }]
      }
      registries: [{ server: registry.properties.loginServer, identity: identity.id }]
      secrets: concat(baseSecrets, bearerSecrets)
    }
    template: {
      containers: [
        {
          name: 'mcp'
          image: mcpExists ? existingApp!.properties.template.containers[0].image : placeholderImage
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat(baseEnv, inboundAuth == 'entra' ? entraEnv : bearerEnv)
          probes: [
            { type: 'Liveness', httpGet: { path: '/healthz', port: 8080 }, periodSeconds: 30, failureThreshold: 3 }
            { type: 'Readiness', httpGet: { path: '/healthz', port: 8080 }, periodSeconds: 10, failureThreshold: 3 }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [{ name: 'http', http: { metadata: { concurrentRequests: '50' } } }]
      }
    }
  }
}

output registryLoginServer string = registry.properties.loginServer
output keyVaultName string = vault.name
output appName string = app.name
output mcpUrl string = '${publicUrl}/mcp'
