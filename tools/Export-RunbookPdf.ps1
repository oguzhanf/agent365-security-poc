[CmdletBinding()]
param(
    [string]$InputFile = (Join-Path $PSScriptRoot '..\docs\Agent-365-Security-PoC.docx'),
    [string]$OutputFile = (Join-Path $PSScriptRoot '..\docs\Agent-365-Security-PoC.pdf')
)

$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $InputFile).Path
$destination = [IO.Path]::GetFullPath($OutputFile)
if ([IO.Path]::GetExtension($source) -ne '.docx') {
    throw 'Select a DOCX input file.'
}
if ([IO.Path]::GetExtension($destination) -ne '.pdf') {
    throw 'Select a PDF output file.'
}
if (-not (Test-Path -LiteralPath (Split-Path $destination -Parent) -PathType Container)) {
    throw 'Create the output directory before conversion.'
}

$word = $null
$document = $null
try {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $word.AutomationSecurity = 3
    $document = $word.Documents.Open($source, $false, $false)
    [void]$document.Fields.Update()
    foreach ($contents in $document.TablesOfContents) {
        $contents.Update()
    }
    $document.Repaginate()
    foreach ($contents in $document.TablesOfContents) {
        $contents.UpdatePageNumbers()
    }
    $document.Save()
    $document.ExportAsFixedFormat($destination, 17, $false, 0, 0, 1, 1, 0, $true, $true, 1, $true, $true, $false)
}
finally {
    if ($null -ne $document) {
        $document.Close($false)
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($document)
    }
    if ($null -ne $word) {
        $word.Quit()
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($word)
    }
}

if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) {
    throw 'Word did not create the PDF file.'
}
Write-Output $destination
