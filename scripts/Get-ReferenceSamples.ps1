[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Destination
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$target = [IO.Path]::GetFullPath($Destination).TrimEnd('\', '/')
$rootPrefix = $root.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
if ($target.Equals($root, [StringComparison]::OrdinalIgnoreCase) -or
    $target.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Select a download directory outside this repository.'
}
if (Test-Path -LiteralPath $target) {
    throw 'The download directory already exists. Select a new directory.'
}
$manifest = Get-Content -LiteralPath (Join-Path $root 'reference-samples.json') -Raw | ConvertFrom-Json
$selected = @($manifest.samples | Where-Object { $_.name -ceq $Name })
if ($selected.Count -ne 1) {
    throw 'Select one sample name from reference-samples.json.'
}
$sample = $selected[0]
if ($sample.repository -notmatch '^https://github\.com/(microsoft|microsoft-foundry)/[A-Za-z0-9_.-]+\.git$') {
    throw 'The sample must use an approved Microsoft GitHub repository.'
}
if ($sample.commit -notmatch '^[a-f0-9]{40}$') {
    throw 'The sample requires a full commit identifier.'
}
if ([IO.Path]::IsPathRooted($sample.path) -or @($sample.path -split '[/\\]') -contains '..') {
    throw 'The sample path must remain inside the downloaded repository.'
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'Install Git before sample download.'
}

Write-Output ('Repository: ' + $sample.repository)
Write-Output ('Commit: ' + $sample.commit)
Write-Output ('Destination: ' + $target)
git init --quiet $target
if ($LASTEXITCODE -ne 0) { throw 'Git could not create the download directory.' }
git -C $target remote add origin $sample.repository
if ($LASTEXITCODE -ne 0) { throw 'Git could not set the source URL.' }
git -C $target fetch --quiet --depth 1 origin $sample.commit
if ($LASTEXITCODE -ne 0) { throw 'Git could not download the pinned commit. Inspect the partial download.' }
git -C $target checkout --quiet --detach FETCH_HEAD
if ($LASTEXITCODE -ne 0) { throw 'Git could not select the pinned commit.' }
$actual = git -C $target rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $actual.Trim() -cne $sample.commit) {
    throw 'The downloaded commit does not match the manifest.'
}
$samplePath = Join-Path $target ($sample.path -replace '/', '\')
if (-not (Test-Path -LiteralPath $samplePath)) {
    throw 'The pinned sample path does not exist.'
}
Write-Output ('Sample path: ' + $samplePath)
Write-Output 'Read the source licence and deployment code before execution.'
Write-Output 'No source code or deployment command was executed.'
