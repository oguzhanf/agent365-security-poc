[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory = $true)][Guid]$TenantId,
    [Parameter(Mandatory = $true)][Guid]$AgentPrincipalId,
    [Guid]$ExpectedAgentAppId = [Guid]::Empty,
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
if ($Apply -and
    (-not $PSBoundParameters.ContainsKey('Confirm') -or -not $PSBoundParameters['Confirm'])) {
    throw 'Apply requires explicit -Confirm. Omitted confirmation and -Confirm:$false are not permitted.'
}
$resourceAppId = '9b975845-388f-4429-889e-eab1ef63949c'
$roleId = '8f71190c-00c8-461d-a63b-f74abde9ba52'
$roleName = 'Agent365.Observability.OtelWrite'
if ($TenantId -eq [Guid]::Empty -or $AgentPrincipalId -eq [Guid]::Empty) {
    throw 'Use nonzero tenant and deployed agentIdentityId values.'
}

function Read-GraphJson([string]$Uri, [switch]$AfterGrant) {
    if (-not $Uri.StartsWith('https://graph.microsoft.com/v1.0/')) {
        throw 'Unexpected Graph pagination endpoint.'
    }
    try {
        $raw = & az rest --method GET --uri $Uri --output json --only-show-errors
        if ($LASTEXITCODE -ne 0) { throw 'Graph command failed.' }
        return ($raw | ConvertFrom-Json)
    }
    catch {
        if ($AfterGrant) { throw 'Graph verification read failed after the grant POST succeeded.' }
        throw 'Graph pre-grant read failed. No role grant was made by this invocation.'
    }
}

$activeTenant = & az account show --query tenantId --output tsv --only-show-errors
if ($LASTEXITCODE -ne 0 -or "$activeTenant".Trim() -ne $TenantId.ToString()) {
    throw 'The existing Azure CLI session must use the approved tenant. This script does not sign in.'
}
$agent = Read-GraphJson "https://graph.microsoft.com/v1.0/servicePrincipals/$AgentPrincipalId"
if ($agent.id -ne $AgentPrincipalId.ToString() -or -not $agent.appId) {
    throw 'The deployed agent service principal could not be resolved.'
}
$agentAppId = [Guid]$agent.appId
if ($agentAppId -eq [Guid]::Empty) { throw 'The agent application ID is invalid.' }
if ($ExpectedAgentAppId -ne [Guid]::Empty -and $ExpectedAgentAppId -ne $agentAppId) {
    throw 'The agent application ID does not match the reviewed value.'
}
if ($Apply -and $ExpectedAgentAppId -eq [Guid]::Empty) {
    throw 'Preview first. Apply requires the reviewed ExpectedAgentAppId.'
}
$filter = [Uri]::EscapeDataString("appId eq '$resourceAppId'")
$resources = Read-GraphJson ('https://graph.microsoft.com/v1.0/servicePrincipals?$filter=' + $filter)
if (@($resources.value).Count -ne 1 -or $resources.value[0].appId -ne $resourceAppId) {
    throw 'Exactly one Agent365Observability principal with the fixed application ID is required.'
}
$resource = $resources.value[0]
$roles = @($resource.appRoles | Where-Object {
    $_.id -eq $roleId -and $_.value -eq $roleName -and
    $_.isEnabled -eq $true -and $_.allowedMemberTypes -contains 'Application'
})
if ($roles.Count -ne 1) { throw 'The fixed observability application role is missing or disabled.' }
$alreadyAssigned = $false
$uri = "https://graph.microsoft.com/v1.0/servicePrincipals/$AgentPrincipalId/appRoleAssignments"
do {
    $page = Read-GraphJson $uri
    foreach ($assignment in @($page.value)) {
        if ($assignment.principalId -eq $AgentPrincipalId.ToString() -and
            $assignment.resourceId -eq $resource.id -and $assignment.appRoleId -eq $roleId) {
            $alreadyAssigned = $true
        }
    }
    $uri = $page.'@odata.nextLink'
} while ($uri)

$body = [ordered]@{
    principalId = $AgentPrincipalId.ToString()
    resourceId = $resource.id
    appRoleId = $roleId
}
[ordered]@{
    tenantId = $TenantId.ToString()
    agentIdentityId = $AgentPrincipalId.ToString()
    A365_AGENT_ID = $agentAppId.ToString()
    target = $body
    alreadyAssigned = $alreadyAssigned
    mode = 'preview; no changes unless -Apply -Confirm and confirmation approval'
} | ConvertTo-Json -Depth 5

if (-not $Apply -or $alreadyAssigned) { return }
if (-not $PSCmdlet.ShouldProcess("$AgentPrincipalId in $TenantId", "Grant only $roleName")) { return }
$directory = Join-Path $PSScriptRoot 'generated'
$createdDirectory = -not (Test-Path -LiteralPath $directory)
$bodyPath = Join-Path $directory ("grant-body-" + [Guid]::NewGuid().ToString() + '.json')
try {
    New-Item -ItemType Directory -Path $directory -Force -Confirm:$false | Out-Null
    $body | ConvertTo-Json | Set-Content -LiteralPath $bodyPath -Encoding UTF8 -Confirm:$false
    $uri = "https://graph.microsoft.com/v1.0/servicePrincipals/$AgentPrincipalId/appRoleAssignments"
    $result = & az rest --method POST --uri $uri --headers Content-Type=application/json --body ("@" + $bodyPath) --output json --only-show-errors
    if ($LASTEXITCODE -ne 0) {
        throw 'Grant was not confirmed. Re-run preview before retrying; do not blindly repeat POST.'
    }
    $receipt = [ordered]@{
        grantMade = $true
        assignmentId = $null
        principalId = $AgentPrincipalId.ToString()
        resourceId = $resource.id
        appRoleId = $roleId
        verification = 'pending'
        readBackUri = $uri
    }
    try {
        $created = $result | ConvertFrom-Json
        if ($created.id -isnot [string] -or [string]::IsNullOrWhiteSpace($created.id)) {
            throw 'The successful POST response did not contain an assignment ID.'
        }
        $receipt.assignmentId = $created.id
        $receipt.readBackUri = $uri + '/' + [Uri]::EscapeDataString($created.id)
        $receipt | ConvertTo-Json
        $verified = Read-GraphJson $receipt.readBackUri -AfterGrant
        if ($verified.id -ne $receipt.assignmentId -or
            $verified.principalId -ne $receipt.principalId -or
            $verified.resourceId -ne $receipt.resourceId -or
            $verified.appRoleId -ne $receipt.appRoleId) {
            throw 'The assignment read-back did not match the successful grant.'
        }
        $receipt.verification = 'confirmed'
        $receipt | ConvertTo-Json
    }
    catch {
        $receipt.verification = 'incomplete'
        $receipt | ConvertTo-Json
        $id = $receipt.assignmentId
        if (-not $id) { $id = 'unavailable in the POST response' }
        throw ("Grant was made; verification incomplete. Assignment ID: $id. " +
            "Run az rest --method GET --uri '$($receipt.readBackUri)'. " +
            "Match principalId='$($receipt.principalId)', resourceId='$($receipt.resourceId)' " +
            "and appRoleId='$($receipt.appRoleId)'. " +
            "Save the receipt and re-run preview without -Apply after propagation. Do not repeat POST.")
    }
}
finally {
    if (Test-Path -LiteralPath $bodyPath) { Remove-Item -LiteralPath $bodyPath -Confirm:$false }
    if ($createdDirectory -and (Test-Path -LiteralPath $directory) -and
        @(Get-ChildItem -LiteralPath $directory -Force).Count -eq 0) {
        Remove-Item -LiteralPath $directory -Confirm:$false
    }
}
