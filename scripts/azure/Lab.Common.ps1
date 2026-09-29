Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:LabRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$script:LabMarker = 'agent365-security-poc'
$script:OpenAIUserRoleId = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'

function Invoke-LabAz {
    param([Parameter(Mandatory = $true)][string[]]$Arguments, [switch]$Json)
    # Do not redirect stderr: native CLI errors must remain visible.
    $output = & az @Arguments --only-show-errors --output json
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "Azure CLI failed (exit $exitCode). No subsequent action was taken."
    }
    $text = $output -join [Environment]::NewLine
    if ($Json) {
        if ([string]::IsNullOrWhiteSpace($text)) { throw 'Azure CLI returned empty JSON.' }
        return ($text | ConvertFrom-Json)
    }
    if (-not [string]::IsNullOrWhiteSpace($text)) { Write-Host $text }
}

function Assert-LabGuid {
    param([string]$Value, [string]$Name)
    if ($Value -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' -or
        $Value -eq [guid]::Empty.ToString()) { throw "$Name must be an explicit nonzero GUID." }
}

function Assert-LabIPv4Range {
    param([string]$Value)
    if ($Value -notmatch '^(\d{1,3}\.){3}\d{1,3}(/([0-9]|[12][0-9]|3[0-2]))?$') {
        throw "Invalid approved IPv4 address or CIDR: $Value"
    }
    $parts = $Value.Split('/')
    $octets = @($parts[0].Split('.') | ForEach-Object {
        if ([int]$_ -gt 255 -or ($_ -ne '0' -and $_.StartsWith('0'))) {
            throw "Invalid IPv4 octet in: $Value"
        }
        [int]$_
    })
    $prefix = 32
    if ($parts.Count -eq 2) { $prefix = [int]$parts[1] }
    # A lab allows at most /24 per approval; never accept /0 or broad supernets.
    if ($prefix -lt 24) { throw "Approved ranges must be /24 or narrower: $Value" }
    if ($octets[0] -eq 0 -or $octets[0] -eq 10 -or $octets[0] -eq 127 -or
        $octets[0] -ge 224 -or ($octets[0] -eq 169 -and $octets[1] -eq 254) -or
        ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) -or
        ($octets[0] -eq 192 -and $octets[1] -eq 168) -or
        ($octets[0] -eq 100 -and $octets[1] -ge 64 -and $octets[1] -le 127)) {
        throw "Use an approved public egress IPv4 address, not a private/reserved range: $Value"
    }
    if ($prefix -lt 32 -and ($octets[3] % [math]::Pow(2, 32 - $prefix)) -ne 0) {
        throw "CIDR must use its network address: $Value"
    }
}

function Read-LabParameters {
    param([Parameter(Mandatory = $true)][string]$Path)
    $document = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    if ($null -eq $document.PSObject.Properties['parameters']) { throw 'ARM parameters object is required.' }
    $values = @{}
    $allowed = @('location', 'owner', 'workspaceName', 'applicationInsightsName', 'dailyQuotaGb',
        'enableSentinel', 'enableAzureOpenAI', 'openAIAccountName', 'approvedIPv4Ranges',
        'modelDeploymentName', 'modelName', 'modelVersion', 'modelSku', 'modelCapacity', 'operatorPrincipalObjectId')
    foreach ($property in $document.parameters.PSObject.Properties) {
        if ($allowed -notcontains $property.Name) { throw "Unknown parameter: $($property.Name)" }
        if ($property.Value.PSObject.Properties.Name -notcontains 'value' -or
            @($property.Value.PSObject.Properties).Count -ne 1) {
            throw "Only literal parameter values are supported: $($property.Name)"
        }
        $values[$property.Name] = $property.Value.value
    }
    foreach ($name in $allowed) {
        if (-not $values.ContainsKey($name)) { throw "Include every example parameter, including $name." }
        if ($values[$name] -is [string] -and $values[$name] -match '[<>]') {
            throw "Replace the placeholder for $name."
        }
    }
    foreach ($name in @('location', 'owner', 'workspaceName', 'applicationInsightsName', 'openAIAccountName',
            'modelDeploymentName', 'modelName', 'modelVersion', 'modelSku', 'operatorPrincipalObjectId')) {
        if ($values[$name] -isnot [string]) { throw "$name must be a string." }
        if ($values[$name] -match '[\x00-\x1f]') { throw "$name contains control characters." }
    }
    foreach ($name in @('location', 'owner', 'workspaceName', 'applicationInsightsName')) {
        if ([string]::IsNullOrWhiteSpace($values[$name]) -or $values[$name] -ne $values[$name].Trim()) {
            throw "$name must be nonempty and have no surrounding whitespace."
        }
    }
    if ($values.location -notmatch '^[a-z][a-z0-9]+$') { throw 'Use a canonical Azure region name.' }
    if ($values.owner.Length -gt 256) { throw 'owner exceeds the Azure tag value limit.' }
    if ($values.workspaceName -notmatch '^[a-zA-Z0-9][a-zA-Z0-9-]{2,61}[a-zA-Z0-9]$') {
        throw 'workspaceName must be 4-63 alphanumeric/hyphen characters.'
    }
    if ($values.applicationInsightsName -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,253}[a-zA-Z0-9]$') {
        throw 'applicationInsightsName must be 2-255 alphanumeric, dot, underscore or hyphen characters.'
    }
    foreach ($name in @('enableSentinel', 'enableAzureOpenAI')) {
        if ($values[$name] -isnot [bool]) { throw "$name must be a JSON boolean." }
    }
    foreach ($name in @('dailyQuotaGb', 'modelCapacity')) {
        if (($values[$name] -isnot [int] -and $values[$name] -isnot [long]) -or
            $values[$name] -gt [int]::MaxValue) { throw "$name must be a 32-bit JSON integer." }
    }
    if ($values.dailyQuotaGb -lt 1 -or $values.modelCapacity -lt 0) { throw 'Invalid quota or capacity.' }
    if ($values.approvedIPv4Ranges -isnot [array]) { throw 'approvedIPv4Ranges must be a JSON array.' }
    foreach ($range in $values.approvedIPv4Ranges) {
        if ($range -isnot [string]) { throw 'Every approved IPv4 range must be a string.' }
        Assert-LabIPv4Range $range
    }
    if (@($values.approvedIPv4Ranges | Select-Object -Unique).Count -ne $values.approvedIPv4Ranges.Count) {
        throw 'Duplicate IPv4 approvals are not allowed.'
    }
    if ($values.operatorPrincipalObjectId) { Assert-LabGuid $values.operatorPrincipalObjectId 'operatorPrincipalObjectId' }
    if ($values.enableAzureOpenAI) {
        if ($values.openAIAccountName -notmatch '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$') {
            throw 'openAIAccountName must be 3-63 lowercase alphanumeric/hyphen characters.'
        }
        foreach ($name in @('modelDeploymentName', 'modelName', 'modelVersion', 'modelSku')) {
            if ($values[$name] -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]*$') { throw "Supply a valid $name." }
        }
        if ($values.modelCapacity -lt 1 -or $values.approvedIPv4Ranges.Count -eq 0) {
            throw 'OpenAI requires positive explicit modelCapacity and at least one approved public IPv4 range.'
        }
    } elseif ($values.operatorPrincipalObjectId) {
        throw 'Operator access requires enableAzureOpenAI=true.'
    }
    return $values
}

function Build-LabTemplate {
    $null = Get-Command az -ErrorAction Stop
    $work = Join-Path $PSScriptRoot '.work'
    $null = New-Item -ItemType Directory -Force -Path $work -WhatIf:$false -Confirm:$false
    $path = Join-Path $work ("compiled-{0}.json" -f [guid]::NewGuid().ToString('N'))
    Invoke-LabAz -Arguments @('bicep', 'build', '--file', (Join-Path $script:LabRoot 'infra\main.bicep'), '--outfile', $path)
    if (-not (Test-Path -LiteralPath $path)) { throw 'Bicep did not produce a template.' }
    return $path
}

function Assert-LabContext {
    param([string]$SubscriptionId, [string]$ExpectedTenantId, [string]$ResourceGroupName)
    Assert-LabGuid $SubscriptionId 'SubscriptionId'
    Assert-LabGuid $ExpectedTenantId 'ExpectedTenantId'
    if ($ResourceGroupName -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._()-]{0,89}$' -or $ResourceGroupName.EndsWith('.')) {
        throw 'Supply an exact resource group name; wildcards and paths are not allowed.'
    }
    $account = Invoke-LabAz -Json -Arguments @('account', 'show', '--subscription', $SubscriptionId,
        '--query', '{id:id,tenantId:tenantId,state:state,environmentName:environmentName}')
    if ($account.id -ne $SubscriptionId -or $account.tenantId -ne $ExpectedTenantId -or $account.state -ne 'Enabled') {
        throw 'Subscription ID, expected tenant ID, or enabled state did not match. No changes made.'
    }
    if ($account.environmentName -ne 'AzureCloud') { throw 'These scripts support Azure public cloud only.' }
}

function Assert-LabTags {
    param($Resource, [string]$Owner)
    $tagsProperty = $Resource.PSObject.Properties['tags']
    if ($null -eq $tagsProperty -or $null -eq $Resource.tags) { throw "Untagged resource rejected: $($Resource.id)" }
    $poc = $Resource.tags.PSObject.Properties['poc']
    $ownerTag = $Resource.tags.PSObject.Properties['owner']
    if ($null -eq $poc -or $poc.Value -cne $script:LabMarker -or
        $null -eq $ownerTag -or [string]::IsNullOrWhiteSpace([string]$ownerTag.Value) -or $ownerTag.Value -cne $Owner) {
        throw "Mixed or unowned resource rejected: $($Resource.id)"
    }
}

function Get-LabCollection {
    param([string]$SubscriptionId, [string]$Path)
    $url = "https://management.azure.com$Path"
    do {
        if (-not $url.StartsWith("https://management.azure.com/subscriptions/$SubscriptionId/", [StringComparison]::OrdinalIgnoreCase)) {
            throw 'ARM pagination escaped the explicitly selected subscription.'
        }
        $page = Invoke-LabAz -Json -Arguments @('rest', '--method', 'get', '--url', $url, '--subscription', $SubscriptionId)
        if ($null -eq $page.PSObject.Properties['value']) { throw 'ARM collection did not return a value array.' }
        foreach ($item in $page.value) { $item }
        $url = $null
        if ($page.PSObject.Properties['nextLink']) { $url = $page.nextLink }
    } while ($url)
}

function ConvertTo-LabCanonical {
    param($Value)
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [System.Collections.IDictionary]) {
        $parts = foreach ($key in @($Value.Keys | Sort-Object)) {
            ($key | ConvertTo-Json -Compress) + ':' + (ConvertTo-LabCanonical $Value[$key])
        }
        return '{' + ($parts -join ',') + '}'
    }
    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        $map = @{}
        foreach ($property in $Value.PSObject.Properties) {
            # Application Insights GET includes connection metadata. Never persist it.
            if ($property.Name -notin @('InstrumentationKey', 'ConnectionString')) { $map[$property.Name] = $property.Value }
        }
        return ConvertTo-LabCanonical $map
    }
    if ($Value -is [array]) {
        $parts = foreach ($item in $Value) { ConvertTo-LabCanonical $item }
        return '[' + ($parts -join ',') + ']'
    }
    return ($Value | ConvertTo-Json -Compress -Depth 100)
}

function Get-LabHash {
    param($Value)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-LabCanonical $Value))
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally { $sha.Dispose() }
}

function Get-LabInventory {
    param([string]$SubscriptionId, [string]$ResourceGroupName, [hashtable]$Parameters)
    $groupId = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroupName"
    $group = Invoke-LabAz -Json -Arguments @('group', 'show', '--name', $ResourceGroupName, '--subscription', $SubscriptionId)
    if ($group.id -ne $groupId) { throw 'Resource group ID mismatch.' }
    Assert-LabTags $group $Parameters.owner
    $expected = @{}
    $workspaceId = "$groupId/providers/Microsoft.OperationalInsights/workspaces/$($Parameters.workspaceName)"
    $insightsId = "$groupId/providers/Microsoft.Insights/components/$($Parameters.applicationInsightsName)"
    $openAIId = "$groupId/providers/Microsoft.CognitiveServices/accounts/$($Parameters.openAIAccountName)"
    $expected[$workspaceId] = '2023-09-01'
    $expected[$insightsId] = '2020-02-02'
    if ($Parameters.enableAzureOpenAI) {
        $expected[$openAIId] = '2024-10-01'
        $expected["$openAIId/deployments/$($Parameters.modelDeploymentName)"] = '2024-10-01'
    }
    $resources = @(Invoke-LabAz -Json -Arguments @('resource', 'list', '--resource-group', $ResourceGroupName,
        '--subscription', $SubscriptionId))
    $byId = @{}
    $listedExtensions = @()
    foreach ($resource in $resources) {
        if (($Parameters.enableSentinel -and $resource.id -eq "$workspaceId/providers/Microsoft.SecurityInsights/onboardingStates/default") -or
            ($Parameters.enableAzureOpenAI -and $Parameters.operatorPrincipalObjectId -and
            $resource.id -like "$openAIId/providers/Microsoft.Authorization/roleAssignments/*")) {
            $listedExtensions += $resource.id
            continue
        }
        if (-not $expected.ContainsKey($resource.id)) { throw "Unexpected resource in dedicated group: $($resource.id)" }
        Assert-LabTags $resource $Parameters.owner
        $byId[$resource.id] = Invoke-LabAz -Json -Arguments @('resource', 'show', '--ids', $resource.id,
            '--api-version', $expected[$resource.id], '--subscription', $SubscriptionId)
        Assert-LabTags $byId[$resource.id] $Parameters.owner
    }
    $children = @()
    foreach ($rootId in @($workspaceId, $insightsId, $openAIId)) {
        if (-not $byId.ContainsKey($rootId)) { continue }
        $diagnostics = Invoke-LabAz -Json -Arguments @('monitor', 'diagnostic-settings', 'list',
            '--resource', $rootId, '--subscription', $SubscriptionId)
        $settings = @()
        if ($null -ne $diagnostics) { $settings = @($diagnostics) }
        if ($null -ne $diagnostics -and $diagnostics.PSObject.Properties['value']) { $settings = @($diagnostics.value) }
        if ($settings.Count -gt 0) { throw "Unexpected diagnostic settings on $rootId. Review manually." }
        $roles = @(Get-LabCollection $SubscriptionId "$rootId/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01")
        foreach ($role in $roles) {
            if ($role.properties.scope -ne $rootId) { continue }
            if ($rootId -ne $openAIId -or -not $Parameters.operatorPrincipalObjectId -or
                $role.properties.principalId -ne $Parameters.operatorPrincipalObjectId -or
                $role.properties.principalType -ne 'User' -or
                $role.properties.roleDefinitionId -ne "/subscriptions/$SubscriptionId/providers/Microsoft.Authorization/roleDefinitions/$script:OpenAIUserRoleId" -or
                $role.properties.description -cne "$script:LabMarker operator access; owner=$($Parameters.owner)") {
                throw "Unexpected resource-scoped role assignment: $($role.id)"
            }
            $children += [pscustomobject]@{ id = $role.id; apiVersion = '2022-04-01'; fingerprint = Get-LabHash $role; parentId = $rootId }
        }
    }
    if ($byId.ContainsKey($openAIId)) {
        $models = @(Get-LabCollection $SubscriptionId "$openAIId/deployments?api-version=2024-10-01")
        foreach ($model in $models) {
            if (-not $expected.ContainsKey($model.id)) { throw "Unexpected model deployment: $($model.id)" }
            Assert-LabTags $model $Parameters.owner
            $byId[$model.id] = $model
        }
        foreach ($collection in @('privateEndpointConnections', 'raiBlocklists', 'commitmentPlans')) {
            $items = @(Get-LabCollection $SubscriptionId "$openAIId/$collection`?api-version=2024-10-01")
            if ($items.Count) { throw "Unexpected OpenAI child collection: $collection. Review manually." }
        }
        $policies = @(Get-LabCollection $SubscriptionId "$openAIId/raiPolicies?api-version=2024-10-01")
        foreach ($policy in $policies) {
            if (-not $policy.properties.PSObject.Properties['type'] -or $policy.properties.type -ne 'SystemManaged') {
                throw "Unexpected custom OpenAI policy: $($policy.id). Review manually."
            }
            $children += [pscustomobject]@{ id = $policy.id; apiVersion = '2024-10-01'; fingerprint = Get-LabHash $policy; parentId = $openAIId; serviceManaged = $true }
        }
    }
    if ($byId.ContainsKey($workspaceId)) {
        $providerState = Invoke-LabAz -Json -Arguments @('provider', 'show', '--namespace', 'Microsoft.SecurityInsights',
            '--subscription', $SubscriptionId, '--query', 'registrationState')
        $states = @()
        if ($providerState -eq 'Registered') {
            $states = @(Get-LabCollection $SubscriptionId "$workspaceId/providers/Microsoft.SecurityInsights/onboardingStates?api-version=2024-03-01")
        } elseif ($Parameters.enableSentinel -or $providerState -ne 'NotRegistered') {
            throw 'Microsoft.SecurityInsights registration is not ready for safe inventory. Review provider state separately.'
        }
        foreach ($state in $states) {
            if (-not $Parameters.enableSentinel -or $state.id -ne "$workspaceId/providers/Microsoft.SecurityInsights/onboardingStates/default") {
                throw "Unexpected Sentinel onboarding: $($state.id)"
            }
            $children += [pscustomobject]@{ id = $state.id; apiVersion = '2024-03-01'; fingerprint = Get-LabHash $state; parentId = $workspaceId }
        }
        foreach ($collection in @('dataExports', 'dataSources', 'savedSearches', 'linkedServices', 'linkedStorageAccounts', 'storageInsightConfigs')) {
            $items = @(Get-LabCollection $SubscriptionId "$workspaceId/$collection`?api-version=2020-08-01")
            if ($items.Count) { throw "Unexpected workspace child collection: $collection. Review manually." }
        }
        foreach ($extensionId in $listedExtensions) {
            if ($extensionId -notin @($children | ForEach-Object { $_.id })) {
                throw "Listed extension could not be independently verified: $extensionId"
            }
        }
        # Service-created tables cannot carry tags. Snapshot their configuration under the guarded workspace.
        $tables = @(Get-LabCollection $SubscriptionId "$workspaceId/tables?api-version=2023-09-01" | Sort-Object id)
        if (@($tables | Where-Object { $_.name -like '*_CL' }).Count) {
            throw 'Custom workspace tables are outside this infrastructure-only lab. Review manually.'
        }
        foreach ($table in $tables) {
            $children += [pscustomobject]@{ id = $table.id; apiVersion = '2023-09-01'; fingerprint = Get-LabHash $table; parentId = $workspaceId; serviceManaged = $true }
        }
        $sentinelChildCollections = @{}
        # Investigation state can survive offboarding. Do not gate these reads on the onboarding resource.
        if ($providerState -eq 'Registered') {
            foreach ($collection in @('alertRules', 'automationRules', 'dataConnectors', 'watchlists', 'bookmarks', 'incidents')) {
                $items = @(Get-LabCollection $SubscriptionId "$workspaceId/providers/Microsoft.SecurityInsights/$collection`?api-version=2024-03-01")
                if ($items.Count) { throw "Unexpected Sentinel child collection: $collection. Preserve investigation state and review manually." }
                $sentinelChildCollections[$collection] = $items
            }
        }
    }
    $entries = @($children)
    foreach ($id in $byId.Keys) {
        $fingerprintInput = $byId[$id]
        if ($id -eq $workspaceId) {
            $fingerprintInput = @{
                resource = $byId[$id]
                sentinelProviderState = $providerState
                sentinelChildCollections = $sentinelChildCollections
            }
        }
        $entries += [pscustomobject]@{ id = $id; apiVersion = $expected[$id]; fingerprint = Get-LabHash $fingerprintInput; parentId = $groupId }
    }
    return [pscustomobject]@{
        groupId = $groupId
        groupFingerprint = Get-LabHash $group
        resources = @($entries | Sort-Object id)
    }
}

function Assert-LabSameInventory {
    param($Before, $After)
    if ((Get-LabHash $Before) -ne (Get-LabHash $After)) {
        throw 'Inventory or resource configuration changed after planning. Stop and create a fresh plan.'
    }
}

function Assert-LabApplyConfirmation {
    param([switch]$Apply, [hashtable]$BoundParameters)
    if ($Apply -and (-not $BoundParameters.ContainsKey('Confirm') -or -not $BoundParameters['Confirm'])) {
        throw 'Writes require both -Apply and explicit -Confirm. -Confirm:$false is rejected.'
    }
}
