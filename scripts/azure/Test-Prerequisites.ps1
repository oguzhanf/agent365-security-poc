#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$ParametersFile
)

. (Join-Path $PSScriptRoot 'Lab.Common.ps1')
$compiled = $null
try {
    if ($ParametersFile) {
        $null = Read-LabParameters $ParametersFile
        Write-Host 'Parameter validation passed.'
    }
    $compiled = Build-LabTemplate
    Write-Host 'Local Bicep compilation passed. No Azure account or resource was read or changed.'
    Write-Host 'Cloud prerequisites are not verified: sign-in, tenant, RBAC, provider registration, region, quota and dedicated group.'
} finally {
    if ($compiled -and (Test-Path -LiteralPath $compiled)) { Remove-Item -LiteralPath $compiled -Force -WhatIf:$false -Confirm:$false }
}
