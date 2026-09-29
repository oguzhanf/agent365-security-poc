#Requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High', DefaultParameterSetName = 'Prepare')]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z][A-Za-z0-9-]{0,127}$')]
    [string]$StackName,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9]{12}$')]
    [string]$ExpectedAccountId,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z]{2}(-gov)?-[a-z]+-[0-9]+$')]
    [string]$Region,
    [Parameter(Mandatory = $true)]
    [string]$ApprovedRegion,
    [Parameter(Mandatory = $true)]
    [switch]$ConfirmClassicAccess,
    [Parameter(Mandatory = $true, ParameterSetName = 'Prepare')]
    [ValidatePattern('^[A-Za-z][A-Za-z0-9-]{0,63}$')]
    [string]$AgentName,
    [Parameter(Mandatory = $true, ParameterSetName = 'Prepare')]
    [string]$FoundationModel,
    [Parameter(Mandatory = $true, ParameterSetName = 'Prepare')]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$')]
    [string]$Owner,
    [Parameter(ParameterSetName = 'Prepare')]
    [ValidatePattern('^(\*|[A-Za-z0-9]{10})$')]
    [string]$TrustedAgentId = '*',
    [Parameter(Mandatory = $true, ParameterSetName = 'Execute')]
    [switch]$Apply,
    [Parameter(Mandatory = $true, ParameterSetName = 'Execute')]
    [ValidatePattern('^arn:(aws|aws-us-gov):cloudformation:[a-z0-9-]+:[0-9]{12}:changeSet/[A-Za-z0-9-]+/[A-Za-z0-9-]+$')]
    [string]$ChangeSetId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-Aws {
    param([string[]]$Arguments, [switch]$AllowFailure)
    # Native stderr must be captured before inspecting LASTEXITCODE in Windows PowerShell 5.1.
    $ErrorActionPreference = 'Continue'
    $text = (& $script:AwsExe @Arguments --region $Region --output json --no-cli-pager --no-cli-auto-prompt --cli-connect-timeout 15 --cli-read-timeout 30 2>&1 | Out-String)
    $code = $LASTEXITCODE
    if ($code -ne 0 -and -not $AllowFailure) {
        throw "AWS CLI failed (exit $code). Output suppressed. Inspect the exact stack or change set in AWS."
    }
    return [pscustomobject]@{ ExitCode = $code; Text = $text }
}

function ConvertFrom-AwsJson {
    param([string]$Text)
    try {
        return ($Text | ConvertFrom-Json -ErrorAction Stop)
    } catch [System.ArgumentException] {
        throw 'AWS returned invalid JSON; output suppressed.'
    }
}

function Get-AwsJson {
    param([string[]]$Arguments)
    $result = Invoke-Aws -Arguments $Arguments
    return (ConvertFrom-AwsJson -Text $result.Text)
}

function Assert-Account {
    $identity = Get-AwsJson -Arguments @('sts', 'get-caller-identity')
    if ($identity.Account -cne $ExpectedAccountId) {
        throw 'Account mismatch. No account switching was attempted.'
    }
}

function Assert-OwnedStack {
    param($Stack)
    $project = @($Stack.Tags | Where-Object { $_.Key -ceq 'Project' -and $_.Value -ceq 'Agent365SecurityPoC' })
    $managed = @($Stack.Tags | Where-Object { $_.Key -ceq 'ManagedBy' -and $_.Value -ceq 'provider-demo' })
    if ($project.Count -ne 1 -or $managed.Count -ne 1) {
        throw 'Stack ownership tags do not match this demo. Refusing modification.'
    }
}

if ($Region -cne $ApprovedRegion) { throw 'Region differs from the explicitly approved region.' }
if (-not $ConfirmClassicAccess) {
    throw 'Existing Bedrock Agents Classic eligibility must be confirmed before continuing.'
}
if ($Apply -and $ChangeSetId -notmatch (':cloudformation:' + [regex]::Escape($Region) + ':' + $ExpectedAccountId + ':')) {
    throw 'Change set account or region mismatch.'
}
if ($PSCmdlet.ParameterSetName -eq 'Execute' -and
    (-not $PSBoundParameters.ContainsKey('Confirm') -or -not $PSBoundParameters['Confirm'])) {
    throw 'Execution requires explicit -Confirm. Omitted confirmation and -Confirm:$false are not permitted.'
}

$modelId = $FoundationModel
if ($PSCmdlet.ParameterSetName -eq 'Prepare') {
    if ($FoundationModel -match '^arn:(aws|aws-us-gov):bedrock:([a-z0-9-]+)::foundation-model/(.+)$') {
        $expectedPartition = 'aws'
        if ($Region.StartsWith('us-gov-')) { $expectedPartition = 'aws-us-gov' }
        if ($Matches[2] -cne $Region -or $Matches[1] -cne $expectedPartition) {
            throw 'Foundation model ARN region or partition mismatch.'
        }
        $modelId = $Matches[3]
    }
    if ($modelId.Length -gt 200 -or $modelId -cnotmatch '^(?!(us|eu|apac|global)\.)[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9.:-]*$') {
        throw 'Use an approved direct foundation model ID or its same-region ARN. Inference profiles are not supported.'
    }
}

Write-Warning 'COST: Bedrock inference can incur charges. This script never invokes the agent. Preparation is not deployment.'
Write-Warning 'Bedrock Agents Classic is closed to new customers. Confirm existing-customer eligibility and model availability.'
if ($WhatIfPreference) {
    Write-Output "No AWS calls. Would target stack '$StackName', account '$ExpectedAccountId', region '$Region'."
    if ($Apply) { Write-Output "Would inspect and execute only '$ChangeSetId'." }
    else { Write-Output "Would prepare a change set for model '$modelId'. No resources would be deployed." }
    return
}

$awsCommand = Get-Command aws -CommandType Application -ErrorAction SilentlyContinue
if (-not $awsCommand) { throw 'AWS CLI v2 is missing. No cloud validation was run.' }
$script:AwsExe = $awsCommand.Source
Assert-Account
$stackResult = Invoke-Aws -Arguments @('cloudformation', 'describe-stacks', '--stack-name', $StackName) -AllowFailure
$stack = $null
if ($stackResult.ExitCode -eq 0) {
    $stacks = @((ConvertFrom-AwsJson -Text $stackResult.Text).Stacks)
    if ($stacks.Count -ne 1) { throw 'Expected exactly one stack.' }
    $stack = $stacks[0]
    if ($stack.StackStatus -ne 'REVIEW_IN_PROGRESS' -or $PSCmdlet.ParameterSetName -eq 'Prepare') {
        Assert-OwnedStack -Stack $stack
    }
} else {
    $notFound = 'Stack with id ' + [regex]::Escape($StackName) + ' does not exist'
    if ($stackResult.Text -notmatch 'ValidationError' -or $stackResult.Text -notmatch $notFound) {
        throw 'Cannot inspect stack. Refusing to interpret this failure as absence. AWS output suppressed.'
    }
}

if ($PSCmdlet.ParameterSetName -eq 'Prepare') {
    $changeType = 'CREATE'
    if ($null -ne $stack -and $stack.StackStatus -ne 'REVIEW_IN_PROGRESS') {
        if ($stack.StackStatus -notin @('CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE')) {
            throw "Stack status '$($stack.StackStatus)' requires manual recovery."
        }
        $changeType = 'UPDATE'
        $existingAgent = @($stack.Outputs | Where-Object { $_.OutputKey -eq 'AgentId' })
        if ($existingAgent.Count -ne 1 -or $existingAgent[0].OutputValue -cnotmatch '^[A-Za-z0-9]{10}$') {
            throw 'Existing stack lacks one valid AgentId output. Refusing an unpinned trust update.'
        }
        if (-not $PSBoundParameters.ContainsKey('TrustedAgentId')) {
            $TrustedAgentId = $existingAgent[0].OutputValue
        }
        if ($TrustedAgentId -cne $existingAgent[0].OutputValue) {
            throw 'TrustedAgentId does not match this stack output.'
        }
    }
    $templatePath = Join-Path $PSScriptRoot 'bedrock-agent.json'
    $null = Get-Content -LiteralPath $templatePath -Raw | ConvertFrom-Json
    $changeName = 'a365-' + [guid]::NewGuid().ToString('N')
    if (-not $PSCmdlet.ShouldProcess("$ExpectedAccountId/$Region/$StackName", "Prepare $changeType change set; no resource execution")) {
        return
    }
    $created = Get-AwsJson -Arguments @(
        'cloudformation', 'create-change-set', '--stack-name', $StackName,
        '--change-set-name', $changeName, '--change-set-type', $changeType,
        '--description', "A365 synthetic lab; type=$changeType",
        '--template-body', "file://$templatePath", '--capabilities', 'CAPABILITY_IAM',
        '--parameters', "ParameterKey=AgentName,ParameterValue=$AgentName",
        "ParameterKey=FoundationModelId,ParameterValue=$modelId",
        "ParameterKey=Owner,ParameterValue=$Owner", "ParameterKey=TrustedAgentId,ParameterValue=$TrustedAgentId",
        '--tags', 'Key=Project,Value=Agent365SecurityPoC', 'Key=ManagedBy,Value=provider-demo',
        "Key=Owner,Value=$Owner", 'Key=Data,Value=synthetic'
    )
    $ChangeSetId = $created.Id
    Write-Output "ChangeSetId: $ChangeSetId"
    $wait = Invoke-Aws -Arguments @('cloudformation', 'wait', 'change-set-create-complete', '--stack-name', $StackName, '--change-set-name', $ChangeSetId) -AllowFailure
    $change = Get-AwsJson -Arguments @('cloudformation', 'describe-change-set', '--stack-name', $StackName, '--change-set-name', $ChangeSetId)
    if ($change.Status -eq 'FAILED') {
        $reason = $change.StatusReason
        if ($reason -match "didn't contain changes|No updates are to be performed") {
            Write-Output 'No changes. The failed empty change set was not executed. It remains for manual removal.'
            return
        }
        throw "Change set failed and was not executed. Inspect '$ChangeSetId' in AWS; provider reason suppressed."
    }
    if ($wait.ExitCode -ne 0 -or $change.Status -ne 'CREATE_COMPLETE' -or $change.ExecutionStatus -ne 'AVAILABLE') {
        throw 'Change set did not reach executable state within the AWS waiter bound. Nothing was executed.'
    }
    $change | ConvertTo-Json -Depth 20
    Write-Output 'Review every change. Rerun with -Apply -Confirm and this exact -ChangeSetId to request execution.'
    return
}

if (-not $Apply) { throw 'Execution requires -Apply.' }
if ($null -eq $stack) { throw 'The reviewed stack does not exist.' }
$change = Get-AwsJson -Arguments @('cloudformation', 'describe-change-set', '--stack-name', $StackName, '--change-set-name', $ChangeSetId)
if ($change.StackId -cne $stack.StackId -or $change.StackName -cne $StackName) { throw 'Change set stack mismatch.' }
if ($change.ChangeSetId -cne $ChangeSetId) { throw 'Change set ID mismatch.' }
if ($change.Status -ne 'CREATE_COMPLETE' -or $change.ExecutionStatus -ne 'AVAILABLE') {
    throw "Change set is not executable: $($change.Status), $($change.ExecutionStatus)."
}
Assert-OwnedStack -Stack $change
$expectedType = 'UPDATE'
if ($stack.StackStatus -eq 'REVIEW_IN_PROGRESS') { $expectedType = 'CREATE' }
elseif ($stack.StackStatus -notin @('CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE')) {
    throw 'Stack is not in an allowed execution state.'
}
if ($change.Description -cne "A365 synthetic lab; type=$expectedType") {
    throw 'Change set was not prepared for this operation by this demo.'
}
$change | ConvertTo-Json -Depth 20
if (-not $PSCmdlet.ShouldProcess("$ExpectedAccountId/$Region/$StackName", "Execute reviewed change set $ChangeSetId; creates or updates billable resources")) {
    return
}
Assert-Account
$null = Invoke-Aws -Arguments @('cloudformation', 'execute-change-set', '--stack-name', $StackName, '--change-set-name', $ChangeSetId)
$waiter = 'stack-create-complete'
if ($expectedType -eq 'UPDATE') { $waiter = 'stack-update-complete' }
$wait = Invoke-Aws -Arguments @('cloudformation', 'wait', $waiter, '--stack-name', $StackName) -AllowFailure
$final = Get-AwsJson -Arguments @('cloudformation', 'describe-stacks', '--stack-name', $StackName)
$finalStacks = @($final.Stacks)
if ($finalStacks.Count -ne 1) { throw 'Expected exactly one completed stack.' }
$finalStack = $finalStacks[0]
if ($finalStack.StackId -cne $stack.StackId -or $finalStack.StackName -cne $StackName) {
    throw 'Completed stack identity mismatch.'
}
Assert-OwnedStack -Stack $finalStack
if ($wait.ExitCode -ne 0 -or $finalStack.StackStatus -notin @('CREATE_COMPLETE', 'UPDATE_COMPLETE')) {
    throw "Deployment is not confirmed successful. Stack status: $($finalStack.StackStatus). Inspect stack events; do not rerun blindly."
}
$agentOutput = @($finalStack.Outputs | Where-Object { $_.OutputKey -eq 'AgentId' })
if ($agentOutput.Count -ne 1 -or $agentOutput[0].OutputValue -cnotmatch '^[A-Za-z0-9]{10}$') {
    throw 'Stack completed without one valid AgentId output.'
}
Write-Output "AgentId: $($agentOutput[0].OutputValue)"
Write-Output "Account: $ExpectedAccountId; Region: $Region; Stack: $StackName"
Write-Output 'Use AgentId to verify manual Microsoft inventory synchronization. It is not an authentication credential.'
