#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
. (Join-Path $root 'scripts\azure\Lab.Common.ps1')
$global:LabTestState = @{
    checks = 0; cliCalls = @(); mockMode = 'empty'; fakeResources = @()
    sentinelOnboarded = $false; sentinelChildCollection = ''; sentinelChildPage = 1
}

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
    $global:LabTestState.checks++
}

function Assert-Throws {
    param([scriptblock]$Action, [string]$Pattern)
    $caught = $null
    try { & $Action } catch { $caught = $_ }
    if ($null -eq $caught) { throw "Expected failure matching: $Pattern" }
    if ($caught.Exception.Message -notmatch $Pattern) { throw "Unexpected failure: $caught" }
    $global:LabTestState.checks++
}

foreach ($file in Get-ChildItem -LiteralPath (Join-Path $root 'scripts\azure') -Filter '*.ps1') {
    $tokens = $null
    $errors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
    Assert-True ($errors.Count -eq 0) "PowerShell parse error in $($file.Name): $errors"
}

$work = Join-Path $root 'scripts\azure\.work'
$null = New-Item -ItemType Directory -Force -Path $work
$parameterPath = Join-Path $work ('unit-parameters-' + [guid]::NewGuid().ToString('N') + '.json')
$planPath = Join-Path $work ('unit-plan-' + [guid]::NewGuid().ToString('N') + '.json')
$sentinelPlanPath = Join-Path $work ('unit-sentinel-plan-' + [guid]::NewGuid().ToString('N') + '.json')
$blockedPlanPath = Join-Path $work ('unit-blocked-plan-' + [guid]::NewGuid().ToString('N') + '.json')
$script:subscription = '11111111-1111-1111-1111-111111111111'
$script:tenant = '22222222-2222-2222-2222-222222222222'
$script:groupId = "/subscriptions/$script:subscription/resourceGroups/rg-isolated-lab"
$script:workspaceId = "$script:groupId/providers/Microsoft.OperationalInsights/workspaces/lab-workspace"
$script:openAIId = "$script:groupId/providers/Microsoft.CognitiveServices/accounts/lab-openai-account"
$global:LabTestState.groupTags = [pscustomobject]@{ poc = 'agent365-security-poc'; owner = 'test-owner' }
$global:LabTestState.subscription = $script:subscription
$global:LabTestState.tenant = $script:tenant
$global:LabTestState.groupId = $script:groupId
$global:LabTestState.openAIId = $script:openAIId
$global:LabTestState.workspaceId = $script:workspaceId

# This function shadows az for every test below. No cloud process is launched.
function az {
    $global:LabTestState.cliCalls += ,@($args)
    $global:LASTEXITCODE = 0
    $command = @($args)
    if ($global:LabTestState.mockMode -eq 'cli-failure') { $global:LASTEXITCODE = 17; return }
    if ($command[0] -eq 'bicep') {
        $index = [array]::IndexOf($command, '--outfile')
        '{}' | Set-Content -LiteralPath $command[$index + 1] -Encoding UTF8 -Confirm:$false -WhatIf:$false
        return
    }
    Assert-True ($command -contains '--subscription') 'Cloud command omitted --subscription.'
    Assert-True ($command -notcontains 'login' -and $command -notcontains 'get-access-token') 'Forbidden credential command.'
    if ($command[0] -eq 'account') {
        $tenantValue = $global:LabTestState.tenant
        if ($global:LabTestState.mockMode -eq 'wrong-tenant') { $tenantValue = '33333333-3333-3333-3333-333333333333' }
        return (@{ id = $global:LabTestState.subscription; tenantId = $tenantValue; state = 'Enabled'; environmentName = 'AzureCloud' } | ConvertTo-Json)
    }
    if ($command[0] -eq 'group') {
        return (@{ id = $global:LabTestState.groupId; name = 'rg-isolated-lab'; tags = $global:LabTestState.groupTags; properties = @{ provisioningState = 'Succeeded' } } | ConvertTo-Json)
    }
    if ($command[0] -eq 'resource' -and $command[1] -eq 'list') {
        return (ConvertTo-Json -InputObject @($global:LabTestState.fakeResources) -Depth 20)
    }
    if ($command[0] -eq 'resource' -and $command[1] -eq 'show') {
        $index = [array]::IndexOf($command, '--ids')
        return (($global:LabTestState.fakeResources | Where-Object { $_.id -eq $command[$index + 1] }) | ConvertTo-Json -Depth 20)
    }
    if ($command[0] -eq 'monitor') { return '{"value":[]}' }
    if ($command[0] -eq 'provider') { return '"Registered"' }
    if ($command[0] -eq 'rest') {
        $index = [array]::IndexOf($command, '--url')
        $url = $command[$index + 1]
        if ($global:LabTestState.mockMode -eq 'untagged-model' -and $url -match '/deployments\?') {
            return (@{ value = @(@{ id = "$($global:LabTestState.openAIId)/deployments/chat"; tags = @{} }) } | ConvertTo-Json -Depth 10)
        }
        if ($global:LabTestState.mockMode -eq 'foreign-pagination') {
            return '{"value":[],"nextLink":"https://example.invalid/collect"}'
        }
        $sentinelRoot = "$($global:LabTestState.workspaceId)/providers/Microsoft.SecurityInsights"
        if ($global:LabTestState.sentinelOnboarded -and $url -match '/onboardingStates\?') {
            return (@{ value = @(@{ id = "$sentinelRoot/onboardingStates/default"; properties = @{ customerManagedKey = $false } }) } | ConvertTo-Json -Depth 10)
        }
        $collection = $global:LabTestState.sentinelChildCollection
        if ($collection -and $url -match "/$collection\?") {
            if ($global:LabTestState.sentinelChildPage -eq 2 -and $url -notmatch '&page=2$') {
                return (@{ value = @(); nextLink = "$url&page=2" } | ConvertTo-Json)
            }
            return (@{ value = @(@{ id = "$sentinelRoot/$collection/investigation-state"; properties = @{ displayName = 'Preserve this investigation' } }) } | ConvertTo-Json -Depth 10)
        }
        return '{"value":[]}'
    }
    if ($command[0] -eq 'deployment' -and $command[2] -eq 'what-if') {
        return '{"status":"Succeeded","changes":[]}'
    }
    throw "Unexpected or mutating Azure CLI command in offline test: $($command -join ' ')"
}

try {
    Assert-Throws { Assert-LabGuid '<subscription>' 'subscription' } 'GUID'
    Assert-Throws { Assert-LabGuid '00000000-0000-0000-0000-000000000000' 'tenant' } 'GUID'
    Assert-LabGuid $script:subscription 'subscription'
    foreach ($ip in @('8.8.8.8', '8.8.8.0/24', '8.8.8.8/32', '8.8.8.0/28')) { Assert-LabIPv4Range $ip }
    foreach ($ip in @('0.0.0.0/0', '1.0.0.0/0', '1.2.3.4/8', '10.0.0.1', '172.16.0.0/24',
            '192.168.0.1', '127.0.0.1', '1.2.3.256', '1.2.3.4/33', '1.2.3.4/24', '::/0', '1.2.03.4', 'abc')) {
        Assert-Throws { Assert-LabIPv4Range $ip } 'IPv4|range|CIDR'
    }
    Assert-Throws { Read-LabParameters (Join-Path $root 'infra\parameters.example.json') } 'placeholder'
    $document = Get-Content -LiteralPath (Join-Path $root 'infra\parameters.example.json') -Raw | ConvertFrom-Json
    $document.parameters.location.value = 'eastus'
    $document.parameters.owner.value = 'test-owner'
    $document.parameters.workspaceName.value = 'lab-workspace'
    $document.parameters.applicationInsightsName.value = 'lab-insights'
    $document | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $parameterPath -Encoding UTF8
    $parameters = Read-LabParameters $parameterPath
    Assert-True (-not $parameters.enableAzureOpenAI -and -not $parameters.enableSentinel) 'Optional services must default off.'
    $document.parameters.enableAzureOpenAI.value = $true
    $document | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $parameterPath -Encoding UTF8
    Assert-Throws { Read-LabParameters $parameterPath } 'openAIAccountName'
    $document.parameters.openAIAccountName.value = 'lab-openai-account'
    $document.parameters.modelDeploymentName.value = 'chat'
    $document.parameters.modelName.value = 'operator-selected-model'
    $document.parameters.modelVersion.value = 'operator-selected-version'
    $document.parameters.modelSku.value = 'Standard'
    $document.parameters.modelCapacity.value = 1
    $document | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $parameterPath -Encoding UTF8
    Assert-Throws { Read-LabParameters $parameterPath } 'approved'
    $document.parameters.approvedIPv4Ranges.value = @('8.8.8.8')
    $document | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $parameterPath -Encoding UTF8
    $openAIParameters = Read-LabParameters $parameterPath

    Assert-Throws { Assert-LabApplyConfirmation -Apply -BoundParameters @{} } 'Confirm'
    Assert-Throws { Assert-LabApplyConfirmation -Apply -BoundParameters @{ Confirm = $false } } 'Confirm'
    Assert-LabApplyConfirmation -Apply -BoundParameters @{ Confirm = $true }
    Assert-Throws { & (Join-Path $root 'scripts\azure\Invoke-Deployment.ps1') -ParametersFile $parameterPath -Apply } 'Confirm'
    Assert-Throws { & (Join-Path $root 'scripts\azure\Remove-Lab.ps1') -ParametersFile $parameterPath -Apply -Confirm:$false } 'Confirm'

    $global:LabTestState.mockMode = 'cli-failure'
    Assert-Throws { Invoke-LabAz -Arguments @('mock') } 'exit 17'
    $global:LabTestState.mockMode = 'wrong-tenant'
    Assert-Throws { Assert-LabContext $script:subscription $script:tenant 'rg-isolated-lab' } 'did not match'
    $global:LabTestState.mockMode = 'empty'
    Assert-LabContext $script:subscription $script:tenant 'rg-isolated-lab'
    $empty = Get-LabInventory $script:subscription 'rg-isolated-lab' $parameters
    Assert-True ($empty.resources.Count -eq 0) 'Empty dedicated group should be valid.'
    $global:LabTestState.groupTags = $null
    Assert-Throws { Get-LabInventory $script:subscription 'rg-isolated-lab' $parameters } 'Untagged'
    $global:LabTestState.groupTags = [pscustomobject]@{ poc = 'agent365-security-poc'; owner = 'other-owner' }
    Assert-Throws { Get-LabInventory $script:subscription 'rg-isolated-lab' $parameters } 'Mixed'
    $global:LabTestState.groupTags.owner = 'test-owner'
    $global:LabTestState.fakeResources = @([pscustomobject]@{ id = $script:workspaceId; name = 'lab-workspace'; tags = $null })
    Assert-Throws { Get-LabInventory $script:subscription 'rg-isolated-lab' $parameters } 'Untagged'
    $global:LabTestState.fakeResources[0].tags = $global:LabTestState.groupTags
    $owned = Get-LabInventory $script:subscription 'rg-isolated-lab' $parameters
    Assert-True ($owned.resources.Count -eq 1) 'Tagged workspace should be enumerated.'
    Assert-Throws { Assert-LabSameInventory $empty $owned } 'changed after planning'
    $changed = $owned | ConvertTo-Json -Depth 20 | ConvertFrom-Json
    $changed.resources[0].fingerprint = 'changed'
    Assert-Throws { Assert-LabSameInventory $owned $changed } 'changed after planning'
    Assert-LabSameInventory $owned ($owned | ConvertTo-Json -Depth 20 | ConvertFrom-Json)
    $global:LabTestState.fakeResources += [pscustomobject]@{ id = "$script:groupId/providers/Microsoft.Storage/storageAccounts/unrelated"; tags = $global:LabTestState.groupTags }
    Assert-Throws { Get-LabInventory $script:subscription 'rg-isolated-lab' $parameters } 'Unexpected resource'
    $global:LabTestState.fakeResources = @([pscustomobject]@{ id = $script:openAIId; tags = $global:LabTestState.groupTags })
    $global:LabTestState.mockMode = 'untagged-model'
    Assert-Throws { Get-LabInventory $script:subscription 'rg-isolated-lab' $openAIParameters } 'Mixed|Untagged'
    $global:LabTestState.mockMode = 'foreign-pagination'
    Assert-Throws { Get-LabCollection $script:subscription "$script:workspaceId/tables?api-version=2023-09-01" } 'escaped'

    $global:LabTestState.mockMode = 'empty'
    $global:LabTestState.fakeResources = @()
    $global:LabTestState.cliCalls = @()
    & (Join-Path $root 'scripts\azure\Invoke-Deployment.ps1') -ParametersFile $parameterPath
    Assert-True ($global:LabTestState.cliCalls.Count -eq 1 -and $global:LabTestState.cliCalls[0][0] -eq 'bicep') 'Default deployment must be local only.'
    $global:LabTestState.cliCalls = @()
    & (Join-Path $root 'scripts\azure\Remove-Lab.ps1') -ParametersFile $parameterPath
    Assert-True ($global:LabTestState.cliCalls.Count -eq 0) 'Default removal must not read Azure.'
    & (Join-Path $root 'scripts\azure\Invoke-Deployment.ps1') -ParametersFile $parameterPath -Plan `
        -SubscriptionId $script:subscription -ExpectedTenantId $script:tenant -ResourceGroupName 'rg-isolated-lab'
    & (Join-Path $root 'scripts\azure\Remove-Lab.ps1') -ParametersFile $parameterPath -Plan -PlanFile $planPath `
        -SubscriptionId $script:subscription -ExpectedTenantId $script:tenant -ResourceGroupName 'rg-isolated-lab'
    Assert-True (Test-Path -LiteralPath $planPath) 'Removal plan was not persisted.'
    & (Join-Path $root 'scripts\azure\Invoke-Deployment.ps1') -ParametersFile $parameterPath -Apply -Confirm -WhatIf `
        -SubscriptionId $script:subscription -ExpectedTenantId $script:tenant -ResourceGroupName 'rg-isolated-lab'
    & (Join-Path $root 'scripts\azure\Remove-Lab.ps1') -ParametersFile $parameterPath -Apply -Confirm -WhatIf `
        -PlanFile $planPath -SubscriptionId $script:subscription -ExpectedTenantId $script:tenant -ResourceGroupName 'rg-isolated-lab'
    Assert-Throws {
        & (Join-Path $root 'scripts\azure\Remove-Lab.ps1') -ParametersFile $parameterPath -Plan -PlanFile $planPath `
            -SubscriptionId $script:subscription -ExpectedTenantId $script:tenant -ResourceGroupName 'rg-isolated-lab'
    } 'already exists'
    $global:LabTestState.fakeResources = @([pscustomobject]@{ id = $script:openAIId; tags = $global:LabTestState.groupTags })
    Assert-Throws {
        & (Join-Path $root 'scripts\azure\Remove-Lab.ps1') -ParametersFile $parameterPath -Apply -Confirm -WhatIf `
            -PlanFile $planPath -SubscriptionId $script:subscription -ExpectedTenantId $script:tenant -ResourceGroupName 'rg-isolated-lab'
    } 'changed after planning'
    $global:LabTestState.fakeResources = @()
    $stale = Get-Content -LiteralPath $planPath -Raw | ConvertFrom-Json
    $stale.createdUtc = [datetime]::UtcNow.AddHours(-2).ToString('o')
    $stale | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $planPath -Encoding UTF8
    Assert-Throws {
        & (Join-Path $root 'scripts\azure\Remove-Lab.ps1') -ParametersFile $parameterPath -Apply -Confirm -WhatIf `
            -PlanFile $planPath -SubscriptionId $script:subscription -ExpectedTenantId $script:tenant -ResourceGroupName 'rg-isolated-lab'
    } 'older than one hour'

    $document.parameters.enableSentinel.value = $true
    $document | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $parameterPath -Encoding UTF8
    $sentinelParameters = Read-LabParameters $parameterPath
    $global:LabTestState.fakeResources = @([pscustomobject]@{ id = $script:workspaceId; name = 'lab-workspace'; tags = $global:LabTestState.groupTags })
    $global:LabTestState.sentinelOnboarded = $true
    $global:LabTestState.cliCalls = @()
    foreach ($collection in @('bookmarks', 'incidents', 'automationRules')) {
        $global:LabTestState.sentinelChildCollection = $collection
        Assert-Throws {
            & (Join-Path $root 'scripts\azure\Remove-Lab.ps1') -ParametersFile $parameterPath -Plan -PlanFile $blockedPlanPath `
                -SubscriptionId $script:subscription -ExpectedTenantId $script:tenant -ResourceGroupName 'rg-isolated-lab'
        } "Unexpected Sentinel child collection: $collection"
        Assert-True (-not (Test-Path -LiteralPath $blockedPlanPath)) "Existing $collection must block plan creation."
    }
    $global:LabTestState.sentinelChildCollection = 'bookmarks'
    Assert-Throws {
        & (Join-Path $root 'scripts\azure\Invoke-Deployment.ps1') -ParametersFile $parameterPath -Plan `
            -SubscriptionId $script:subscription -ExpectedTenantId $script:tenant -ResourceGroupName 'rg-isolated-lab'
    } 'Unexpected Sentinel child collection: bookmarks'
    $global:LabTestState.sentinelChildCollection = ''
    & (Join-Path $root 'scripts\azure\Remove-Lab.ps1') -ParametersFile $parameterPath -Plan -PlanFile $sentinelPlanPath `
        -SubscriptionId $script:subscription -ExpectedTenantId $script:tenant -ResourceGroupName 'rg-isolated-lab'
    $sentinelPlan = Get-Content -LiteralPath $sentinelPlanPath -Raw | ConvertFrom-Json
    $workspaceEntry = $sentinelPlan.inventory.resources | Where-Object { $_.id -eq $script:workspaceId }
    Assert-True ($workspaceEntry.fingerprint -ne (Get-LabHash $global:LabTestState.fakeResources[0])) 'Workspace digest must include Sentinel collection checks.'
    foreach ($collection in @('bookmarks', 'incidents', 'automationRules')) {
        $global:LabTestState.sentinelChildCollection = $collection
        Assert-Throws {
            & (Join-Path $root 'scripts\azure\Remove-Lab.ps1') -ParametersFile $parameterPath -Apply -Confirm -WhatIf `
                -PlanFile $sentinelPlanPath -SubscriptionId $script:subscription -ExpectedTenantId $script:tenant -ResourceGroupName 'rg-isolated-lab'
        } "Unexpected Sentinel child collection: $collection"
    }
    $global:LabTestState.sentinelChildCollection = 'bookmarks'
    $global:LabTestState.sentinelChildPage = 2
    Assert-Throws { Get-LabInventory $script:subscription 'rg-isolated-lab' $sentinelParameters } 'Unexpected Sentinel child collection: bookmarks'
    $global:LabTestState.sentinelOnboarded = $false
    Assert-Throws { Get-LabInventory $script:subscription 'rg-isolated-lab' $sentinelParameters } 'Unexpected Sentinel child collection: bookmarks'
    Assert-Throws { Get-LabInventory $script:subscription 'rg-isolated-lab' $parameters } 'Unexpected Sentinel child collection: bookmarks'
    $mutations = @($global:LabTestState.cliCalls | Where-Object {
        ($_[0] -eq 'resource' -and $_[1] -eq 'delete') -or ($_[0] -eq 'deployment' -and $_[2] -eq 'create')
    })
    Assert-True ($mutations.Count -eq 0) 'Investigation-state guards must fail before any Azure mutation.'
    Write-Host "Offline lifecycle checks passed: $($global:LabTestState.checks)"
} finally {
    foreach ($path in @($parameterPath, $planPath, $sentinelPlanPath, $blockedPlanPath)) {
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force -Confirm:$false -WhatIf:$false }
    }
    Remove-Variable -Name LabTestState -Scope Global
}
