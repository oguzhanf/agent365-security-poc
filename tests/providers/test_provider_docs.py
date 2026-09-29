import base64
import importlib.util
import json
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "providers" / "aws" / "Prepare-BedrockDemo.ps1"
CHAPTERS = json.loads((ROOT / "docs" / "provider-chapters.json").read_text(encoding="utf-8"))["chapters"]
SPEC = importlib.util.spec_from_file_location(
    "documented_provider_cli", ROOT / "providers" / "anthropic" / "managed_agent_demo.py"
)
demo = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(demo)


class ProviderDocumentationTests(unittest.TestCase):
    def test_chapter_source_shapes_and_citations(self):
        chapters = CHAPTERS
        sources = json.loads((ROOT / "docs" / "provider-sources.json").read_text(encoding="utf-8"))["sources"]
        identifiers = {source["id"] for source in sources}
        self.assertEqual(len(identifiers), len(sources))
        for chapter in chapters:
            self.assertEqual(set(chapter), {"title", "paragraphs", "sections"})
            for section in chapter["sections"]:
                self.assertEqual(set(section), {"title", "paragraphs", "steps", "items", "code", "notes"})
                self.assertIsInstance(section["code"], str)
        for source in sources:
            self.assertEqual(set(source), {"id", "title", "url", "retrieved", "note"})
            self.assertEqual(source["retrieved"], "2026-09-18")
            self.assertRegex(source["id"], r"^V\d\d$")
            self.assertTrue(source["url"].startswith(("https://docs.aws.amazon.com/", "https://learn.microsoft.com/", "https://platform.claude.com/")))
        self.assertTrue(set(re.findall(r"V\d\d", json.dumps(chapters))) <= identifiers)

    def test_classic_eligibility_and_real_sync_are_required(self):
        text = (ROOT / "docs" / "provider-chapters.json").read_text(encoding="utf-8")
        self.assertIn("ONB-10 is REQUIRED", text)
        self.assertIn("Classic path BLOCKED", text)
        self.assertIn("An existing AWS account alone does not establish eligibility", text)
        self.assertIn("Do not silently substitute AgentCore", text)
        self.assertIn("Do not report provider readiness as PASS", text)
        self.assertIn("ONB-05, does not satisfy ONB-10", text)
        self.assertNotRegex(text, r"(?i)(optional.{0,30}(sync|ONB-07|ONB-10)|(sync|ONB-07|ONB-10).{0,30}optional)")

    def test_claude_preview_sync_is_required_and_can_block_acceptance(self):
        text = (ROOT / "docs" / "provider-chapters.json").read_text(encoding="utf-8")
        self.assertIn("ONB-07 is REQUIRED", text)
        self.assertIn("This is a preview connection", text)
        self.assertIn("Missing beta or preview approval blocks agreed catalogue acceptance", text)
        self.assertIn("Mark ONB-07 BLOCKED", text)
        self.assertIn("matching provider agent_id as ONB-07 evidence", text)
        self.assertIn("Neither result substitutes for the other", text)

    def test_documented_python_commands_match_real_parser_and_plans(self):
        values = {
            "$WorkspaceId": "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ",
            "$ModelId": "claude-sonnet-4-6",
            "$AgentId": "agent_011CZkYpogX7uDKUyvBTophP",
            "$AgentVersion": "1",
            "$EnvironmentId": "env_011CZkZ9X2dpNyB7HsEFoRfW",
            "$SessionId": "sesn_011CZkZAtmR3yMPDzynEDxu7",
            "$EventId": "evt_synthetic123456",
        }
        documented = set()
        for chapter in CHAPTERS:
            for section in chapter["sections"]:
                for line in section["code"].splitlines():
                    if not line.startswith("python .\\providers\\anthropic\\managed_agent_demo.py "):
                        continue
                    with self.subTest(line=line):
                        tokens = shlex.split(line, posix=False)[2:]
                        argv = [values.get(token, token) for token in tokens]
                        self.assertFalse(any(token.startswith("$") for token in argv))
                        args = demo.parser().parse_args(argv)
                        plan = demo.plans(args)
                        self.assertTrue(plan)
                        documented.add(args.command)
        self.assertEqual(documented, {
            "create-agent", "create-environment", "run", "watch",
            "delete-session", "delete-environment", "archive-agent",
        })
        text = json.dumps(CHAPTERS)
        self.assertIn(demo.BETA, text)
        self.assertIn(demo.headers(values["$WorkspaceId"])["anthropic-version"], text)
        self.assertIn("--max-polls", text)

    @unittest.skipUnless(shutil.which("powershell"), "Windows PowerShell 5.1 unavailable.")
    def test_powershell_script_and_all_document_commands_parse(self):
        codes = [section["code"] for chapter in CHAPTERS for section in chapter["sections"] if section["code"]]
        encoded = base64.b64encode(json.dumps(codes).encode()).decode()
        wrapper = r"""
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
    throw 'This test requires the Windows PowerShell 5.1 parser.'
}
$tokens = $null
$errors = $null
$scriptAst = [System.Management.Automation.Language.Parser]::ParseFile('__SCRIPT__', [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw ($errors | Out-String) }
$names = @($scriptAst.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath }) + @('WhatIf', 'Confirm')
$codes = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__CODES__')))
$checked = 0
foreach ($code in $codes) {
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($code, [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) { throw ($errors | Out-String) }
    $commands = @($ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.CommandAst] -and
        $node.GetCommandName() -eq '.\providers\aws\Prepare-BedrockDemo.ps1'
    }, $true))
    foreach ($command in $commands) {
        foreach ($parameter in @($command.CommandElements | Where-Object {
            $_ -is [System.Management.Automation.Language.CommandParameterAst]
        })) {
            if ($parameter.ParameterName -notin $names) { throw ('Unknown script parameter: ' + $parameter.ParameterName) }
        }
        if ($command.Extent.Text -match ' -Apply' -and $command.Extent.Text -notmatch ' -Confirm') {
            throw 'Documented execution must request confirmation.'
        }
        $checked++
    }
    if ($commands.Count -gt 0) {
        foreach ($table in @($ast.FindAll({
            param($node) $node -is [System.Management.Automation.Language.HashtableAst]
        }, $true))) {
            foreach ($pair in $table.KeyValuePairs) {
                if ($pair.Item1.Value -notin $names) { throw ('Unknown splatted parameter: ' + $pair.Item1.Value) }
            }
        }
    }
}
if ($checked -lt 3) { throw 'Provider deployment examples were not checked.' }
Write-Output ('Parsed script and ' + $codes.Count + ' command blocks; validated ' + $checked + ' deployment commands.')
"""
        wrapper = wrapper.replace("__SCRIPT__", str(SCRIPT).replace("'", "''")).replace("__CODES__", encoded)
        command = base64.b64encode(wrapper.encode("utf-16-le")).decode()
        process = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", command],
            capture_output=True, text=True, timeout=30, cwd=ROOT,
        )
        self.assertEqual(process.returncode, 0, process.stdout + process.stderr)


if __name__ == "__main__":
    unittest.main()
