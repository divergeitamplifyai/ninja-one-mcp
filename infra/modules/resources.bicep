// Everything inside the resource group. See ../main.bicep for parameters.

param location string
param tags object
param token string
param ninjaRegion string
param ninjaClientId string
@secure()
param ninjaClientSecret string
param ninjaScopes string
param ninjaMode string
param ninjaAllowDestructive string
param ninjaAllowedOrgIds string
param ninjaToolsets string
param inboundAuth string
param tenantId string
param entraClientId string
param entraAppIdUri string
@secure()
param bearerToken string
param allowedIpRanges array
param allowedOrigins string
param containerImage string
param minReplicas int
param maxReplicas int

var appName = 'ca-ninjaone-${token}'
// Built-in role definition ids.
var keyVaultSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'
var acrPull = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-ninjaone-${token}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-ninjaone-${token}'
  location: location
  tags: tags
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'kv-n1-${take(token, 18)}'
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

resource ninjaSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'ninjaone-client-secret'
  properties: { value: ninjaClientSecret, contentType: 'NinjaOne API client secret' }
}

resource bearerSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (inboundAuth == 'bearer') {
  parent: vault
  name: 'mcp-bearer-token'
  properties: { value: bearerToken, contentType: 'Shared bearer token for the MCP endpoint' }
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
  #disable-next-line BCP334
  name: 'crn1${take(token, 20)}'
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
  }
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
  name: 'cae-ninjaone-${token}'
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

var publicUrl = 'https://${appName}.${env.properties.defaultDomain}'
var appIdUri = empty(entraAppIdUri) ? 'api://${entraClientId}' : entraAppIdUri

var baseEnv = [
  { name: 'NINJAONE_REGION', value: ninjaRegion }
  { name: 'NINJAONE_CLIENT_ID', value: ninjaClientId }
  { name: 'NINJAONE_CLIENT_SECRET', secretRef: 'ninjaone-client-secret' }
  { name: 'NINJAONE_SCOPES', value: ninjaScopes }
  { name: 'NINJAONE_MODE', value: ninjaMode }
  { name: 'NINJAONE_ALLOW_DESTRUCTIVE', value: ninjaAllowDestructive }
  { name: 'NINJAONE_ALLOWED_ORG_IDS', value: ninjaAllowedOrgIds }
  { name: 'NINJAONE_TOOLSETS', value: ninjaToolsets }
  { name: 'NINJAONE_HTTP_PUBLIC_URL', value: publicUrl }
  { name: 'NINJAONE_HTTP_ALLOWED_ORIGINS', value: allowedOrigins }
  { name: 'NINJAONE_HTTP_AUTH', value: inboundAuth }
]
var entraEnv = [
  { name: 'NINJAONE_HTTP_ENTRA_TENANT_ID', value: tenantId }
  { name: 'NINJAONE_HTTP_ENTRA_CLIENT_ID', value: entraClientId }
  { name: 'NINJAONE_HTTP_ENTRA_APP_ID_URI', value: appIdUri }
]
var bearerEnv = [{ name: 'NINJAONE_HTTP_BEARER_TOKENS', secretRef: 'mcp-bearer-token' }]

var baseSecrets = [
  { name: 'ninjaone-client-secret', keyVaultUrl: ninjaSecret.properties.secretUri, identity: identity.id }
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
          // azd replaces this with the image it builds. Until then the published image keeps probes healthy.
          image: empty(containerImage) ? 'ghcr.io/patrickking67/ninja-one-mcp:latest' : containerImage
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
