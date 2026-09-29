targetScope = 'resourceGroup'

@description('Azure region approved by the operator. Model availability and quota must be checked separately.')
@minLength(1)
param location string

@description('Owner tag. Must exactly match the existing dedicated resource group.')
@minLength(1)
param owner string

@minLength(4)
@maxLength(63)
param workspaceName string

@minLength(1)
@maxLength(255)
param applicationInsightsName string

@description('Log Analytics daily ingestion quota in GB. Not a spending cap.')
@minValue(1)
param dailyQuotaGb int = 1

param enableSentinel bool = false
param enableAzureOpenAI bool = false

@description('Globally unique OpenAI account and custom subdomain name, required when enabled.')
param openAIAccountName string = ''

@description('Explicitly approved public IPv4 addresses or CIDRs. The lifecycle scripts reject broad or invalid ranges.')
param approvedIPv4Ranges string[] = []

param modelDeploymentName string = ''
param modelName string = ''
param modelVersion string = ''
param modelSku string = ''

@description('Operator-selected model SKU capacity units; zero is valid only when OpenAI is disabled.')
@minValue(0)
param modelCapacity int = 0

@description('Optional human operator object ID in the expected tenant. NOT an Entra Agent ID or application/client ID.')
param operatorPrincipalObjectId string = ''

var labTags = {
  poc: 'agent365-security-poc'
  owner: owner
}
var openAIUserRoleId = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  tags: labTags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
    workspaceCapping: {
      dailyQuotaGb: dailyQuotaGb
    }
    features: {
      disableLocalAuth: true
      enableLogAccessUsingOnlyResourcePermissions: true
    }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource applicationInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: applicationInsightsName
  location: location
  kind: 'web'
  tags: labTags
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
    DisableLocalAuth: true
    DisableIpMasking: false
    IngestionMode: 'LogAnalytics'
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource sentinel 'Microsoft.SecurityInsights/onboardingStates@2024-03-01' = if (enableSentinel) {
  name: 'default'
  scope: workspace
  properties: {
    customerManagedKey: false
  }
}

resource openAI 'Microsoft.CognitiveServices/accounts@2024-10-01' = if (enableAzureOpenAI) {
  name: openAIAccountName
  location: location
  kind: 'OpenAI'
  tags: labTags
  sku: {
    name: 'S0'
  }
  properties: {
    customSubDomainName: openAIAccountName
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'None'
      ipRules: [for range in approvedIPv4Ranges: {
        value: range
      }]
      virtualNetworkRules: []
    }
  }
}

resource model 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = if (enableAzureOpenAI) {
  parent: openAI
  name: modelDeploymentName
  tags: labTags
  sku: {
    name: modelSku
    capacity: modelCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: modelName
      version: modelVersion
    }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}

resource operatorAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableAzureOpenAI && !empty(operatorPrincipalObjectId)) {
  name: guid(openAI.id, operatorPrincipalObjectId, openAIUserRoleId)
  scope: openAI
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', openAIUserRoleId)
    principalId: operatorPrincipalObjectId
    principalType: 'User'
    description: 'agent365-security-poc operator access; owner=${owner}'
  }
}

output workspaceResourceId string = workspace.id
output applicationInsightsResourceId string = applicationInsights.id
output openAIResourceId string = enableAzureOpenAI ? openAI.id : ''
output modelDeploymentResourceId string = enableAzureOpenAI ? model.id : ''
