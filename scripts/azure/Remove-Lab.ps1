#requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory = $true)][string]$ParametersFile,
    [string]$SubscriptionId,
    [string]$ExpectedTenantId,
    [string]$ResourceGroupName,
    [switch]$Plan,
    [switch]$Apply,
    [string]$PlanFile = (Join-Path $PSScriptRoot '.work\removal-plan.json')
)

. (Join-Path $PSScriptRoot 'Lab.Common.ps1')
Assert-LabApplyConfirmation -Apply:$Apply -BoundParameters $PSBoundParameters
if ($Plan -and $Apply) { throw 'Use -Plan to save a plan, then a separate -Apply -Confirm invocation.' }
$parameters = Read-LabParameters $ParametersFile
if (-not $Plan -and -not $Apply -and -not $WhatIfPreference) {
    Write-Host 'Local parameter validation passed. Nothing deleted. Use -Plan to read Azure and save an exact inventory.'
    return
}
Assert-LabContext $SubscriptionId $ExpectedTenantId $ResourceGroupName
$inventory = Get-LabInventory $SubscriptionId $ResourceGroupName $parameters
if (-not $Apply) {
    if (Test-Path -LiteralPath $PlanFile) { throw 'PlanFile already exists. Choose a new filename; plans are never overwritten.' }
    $directory = Split-Path -Parent ([IO.Path]::GetFullPath($PlanFile))
    $null = New-Item -ItemType Directory -Force -Path $directory -WhatIf:$false -Confirm:$false
    $planDocument = [ordered]@{
        schemaVersion = 1
        createdUtc = [datetime]::UtcNow.ToString('o')
        subscriptionId = $SubscriptionId
        expectedTenantId = $ExpectedTenantId
        parametersHash = Get-LabHash $parameters
        inventory = $inventory
    }
    $planDocument | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $PlanFile -Encoding UTF8 -WhatIf:$false -Confirm:$false
    Write-Host 'Planned exact resources (service tables are removed only with their parent workspace):'
    foreach ($resource in $inventory.resources) { Write-Host $resource.id }
    Write-Host "Removal plan saved to $PlanFile. Nothing deleted. The resource group will be retained."
    return
}

$planDocument = Get-Content -LiteralPath $PlanFile -Raw | ConvertFrom-Json
$planTime = [datetime]::Parse($planDocument.createdUtc).ToUniversalTime()
if ($planDocument.schemaVersion -ne 1 -or $planDocument.subscriptionId -ne $SubscriptionId -or
    $planDocument.expectedTenantId -ne $ExpectedTenantId -or
    $planDocument.parametersHash -ne (Get-LabHash $parameters) -or
    $planTime -gt [datetime]::UtcNow -or $planTime -lt [datetime]::UtcNow.AddHours(-1)) {
    throw 'Plan is invalid, belongs to different inputs, or is older than one hour. Create a fresh plan.'
}
Assert-LabSameInventory $planDocument.inventory $inventory
Write-Host 'Exact resources covered by this deletion:'
foreach ($resource in $inventory.resources) { Write-Host $resource.id }
if (-not $PSCmdlet.ShouldProcess($inventory.groupId, 'Delete the displayed lab resources and stored telemetry; retain the group')) { return }

Assert-LabContext $SubscriptionId $ExpectedTenantId $ResourceGroupName
Assert-LabSameInventory $inventory (Get-LabInventory $SubscriptionId $ResourceGroupName $parameters)
$remaining = $inventory
# Explicit child IDs first, then Insights, OpenAI and workspace. Never use resource-group delete.
$targets = @($inventory.resources | Where-Object { -not $_.PSObject.Properties['serviceManaged'] } |
    Sort-Object @{ Expression = {
        if ($_.id -match '/providers/Microsoft.Authorization/roleAssignments/' -or
            $_.id -match '/providers/Microsoft.SecurityInsights/onboardingStates/' -or $_.id -match '/deployments/') { 0 }
        elseif ($_.id -match '/providers/Microsoft.Insights/components/') { 1 }
        elseif ($_.id -match '/providers/Microsoft.CognitiveServices/accounts/') { 2 }
        else { 3 }
    } }, id)
foreach ($target in $targets) {
    $current = Get-LabInventory $SubscriptionId $ResourceGroupName $parameters
    Assert-LabSameInventory $remaining $current
    Invoke-LabAz -Arguments @('resource', 'delete', '--ids', $target.id,
        '--api-version', $target.apiVersion, '--subscription', $SubscriptionId)
    # CLI delete waits for ARM completion. Verify absence and verify that only the planned subtree disappeared.
    $remaining.resources = @($remaining.resources | Where-Object {
        $_.id -ne $target.id -and -not $_.id.StartsWith($target.id + '/', [StringComparison]::OrdinalIgnoreCase)
    })
    $after = Get-LabInventory $SubscriptionId $ResourceGroupName $parameters
    Assert-LabSameInventory $remaining $after
}
Write-Host 'Verified: planned lab resources are absent. The tagged resource group and deployment history remain.'
Write-Host 'No tenant objects were deleted. Service soft-deleted resources were not purged.'
