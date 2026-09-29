#requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory = $true)][string]$ParametersFile,
    [string]$SubscriptionId,
    [string]$ExpectedTenantId,
    [string]$ResourceGroupName,
    [switch]$Plan,
    [switch]$Apply
)

. (Join-Path $PSScriptRoot 'Lab.Common.ps1')
Assert-LabApplyConfirmation -Apply:$Apply -BoundParameters $PSBoundParameters
$parameters = Read-LabParameters $ParametersFile
$compiled = $null
$parameterSnapshot = $null
try {
    $compiled = Build-LabTemplate
    if (-not $Plan -and -not $Apply -and -not $WhatIfPreference) {
        Write-Host 'Local parameter validation and compilation passed. Use -Plan for Azure read-only what-if.'
        return
    }
    Assert-LabContext $SubscriptionId $ExpectedTenantId $ResourceGroupName
    $before = Get-LabInventory $SubscriptionId $ResourceGroupName $parameters
    # Freeze validated inputs; edits to the operator file cannot change the confirmed deployment.
    $parameterSnapshot = [IO.Path]::ChangeExtension($compiled, 'parameters.json')
    $literalParameters = @{}
    foreach ($name in $parameters.Keys) { $literalParameters[$name] = @{ value = $parameters[$name] } }
    @{ parameters = $literalParameters } | ConvertTo-Json -Depth 20 |
        Set-Content -LiteralPath $parameterSnapshot -Encoding UTF8 -WhatIf:$false -Confirm:$false
    $templateHash = (Get-FileHash -LiteralPath $compiled -Algorithm SHA256).Hash
    $parameterHash = (Get-FileHash -LiteralPath $parameterSnapshot -Algorithm SHA256).Hash
    $deploymentName = 'agent365-security-poc'
    $common = @('--subscription', $SubscriptionId, '--resource-group', $ResourceGroupName,
        '--name', $deploymentName, '--mode', 'Incremental', '--template-file', $compiled,
        '--parameters', ('@' + $parameterSnapshot))
    $preview = Invoke-LabAz -Json -Arguments (@('deployment', 'group', 'what-if') + $common + @('--no-pretty-print'))
    if ($preview.PSObject.Properties['status'] -and $preview.status -ne 'Succeeded') {
        throw 'Azure what-if did not succeed.'
    }
    Write-Host ($preview | ConvertTo-Json -Depth 100)
    if (-not $Apply) {
        Write-Host 'What-if only. No deployment was submitted.'
        return
    }
    Assert-LabSameInventory $before (Get-LabInventory $SubscriptionId $ResourceGroupName $parameters)
    if ($PSCmdlet.ShouldProcess($before.groupId, 'Apply the displayed incremental Azure lab deployment')) {
        Assert-LabContext $SubscriptionId $ExpectedTenantId $ResourceGroupName
        Assert-LabSameInventory $before (Get-LabInventory $SubscriptionId $ResourceGroupName $parameters)
        if ((Get-FileHash -LiteralPath $compiled -Algorithm SHA256).Hash -ne $templateHash -or
            (Get-FileHash -LiteralPath $parameterSnapshot -Algorithm SHA256).Hash -ne $parameterHash) {
            throw 'Deployment inputs changed after what-if. Stop and retry.'
        }
        $result = Invoke-LabAz -Json -Arguments (@('deployment', 'group', 'create') + $common)
        if ($result.properties.provisioningState -ne 'Succeeded') { throw 'Deployment did not succeed.' }
        $null = Get-LabInventory $SubscriptionId $ResourceGroupName $parameters
        Write-Host 'Azure lab deployment succeeded. No agent or tenant security policy was deployed.'
    }
} finally {
    foreach ($path in @($compiled, $parameterSnapshot)) {
        if ($path -and (Test-Path -LiteralPath $path)) { Remove-Item -LiteralPath $path -Force -WhatIf:$false -Confirm:$false }
    }
}
