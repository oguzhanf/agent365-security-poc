[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location $root
try {
    foreach ($directory in @('tests\evidence', 'tests\infra', 'tests\runtime', 'tests\providers', 'tests\foundry')) {
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
            throw ('The test directory is absent: ' + $directory)
        }
        python -m unittest discover -s $directory -p 'test_*.py' -v
        if ($LASTEXITCODE -ne 0) { throw ('The tests failed: ' + $directory) }
    }
    npm run test:docs
    if ($LASTEXITCODE -ne 0) { throw 'The document tests failed.' }
    npm run test:site
    if ($LASTEXITCODE -ne 0) { throw 'The site tests failed.' }
    $files = Get-ChildItem -Path scripts,tools -Filter '*.ps1' -Recurse
    foreach ($file in $files) {
        $tokens = $null
        $parseErrors = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile(
            $file.FullName, [ref]$tokens, [ref]$parseErrors)
        if ($parseErrors.Count -gt 0) {
            throw ($file.FullName + ': ' + ($parseErrors.Message -join '; '))
        }
    }
    Write-Output 'Local checks passed. No tenant control was tested.'
}
finally {
    Pop-Location
}
