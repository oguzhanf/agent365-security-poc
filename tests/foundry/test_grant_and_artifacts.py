import ast
import base64
import json
from pathlib import Path
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
HOSTED = ROOT / "hosted_foundry"
POWERSHELL = shutil.which("powershell.exe") or shutil.which("pwsh")
TENANT = "11111111-1111-4111-8111-111111111111"
PRINCIPAL = "33333333-3333-4333-8333-333333333333"
APP = "22222222-2222-4222-8222-222222222222"
RESOURCE = "44444444-4444-4444-8444-444444444444"
RESOURCE_APP = "9b975845-388f-4429-889e-eab1ef63949c"
ROLE = "8f71190c-00c8-461d-a63b-f74abde9ba52"


class ArtifactTests(unittest.TestCase):
    def test_python_syntax_and_no_runtime_imports(self):
        for path in (HOSTED / "src").rglob("*.py"):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom):
                    self.assertFalse((node.module or "").startswith("runtime"))
                if isinstance(node, ast.Import):
                    self.assertFalse(any(alias.name.startswith("runtime") for alias in node.names))

    def test_exact_direct_dependency_pins(self):
        requirements = (HOSTED / "src" / "requirements.txt").read_text().splitlines()
        for item in requirements:
            self.assertRegex(item, r"^[a-z0-9-]+==[0-9][a-z0-9.]+$")
        self.assertIn("microsoft-opentelemetry==1.3.9", requirements)
        self.assertNotIn("microsoft-agents-a365-observability", "\n".join(requirements))

    def test_manifest_uses_existing_model_and_code_protocol(self):
        manifest = (HOSTED / "azure.yaml").read_text()
        for expected in ("host: azure.ai.agent", "kind: hosted", "version: 2.0.0",
                         "runtime: python_3_13", "entryPoint: main.py",
                         "dependencyResolution: remote_build", "project: src",
                         "${AZURE_AI_MODEL_DEPLOYMENT_NAME}", "${POC_A365_EXPORT:-false}",
                         "endpoint: ${POC_EXISTING_PROJECT_ENDPOINT}"):
            self.assertIn(expected, manifest)
        for unwanted in ("deployments:", "sku:", "gpt-", "FOUNDRY_PROJECT_ENDPOINT:", "image:"):
            self.assertNotIn(unwanted, manifest)


@unittest.skipUnless(POWERSHELL, "PowerShell is not available")
class GrantTests(unittest.TestCase):
    def run_mock(self, scenario, apply=False, expected=APP, confirm="-Confirm",
                 confirm_preference="None", confirmation_answer="Y"):
        script = str(HOSTED / "Grant-ObservabilityRole.ps1").replace("'", "''")
        command = r"""
$ErrorActionPreference = 'Stop'
$ConfirmPreference = 'CONFIRM_PREFERENCE'
$global:calls = @()
$global:posted = $false
$global:emitted = @()
function global:az {
    $global:LASTEXITCODE = 0
    $global:calls += ,@($args)
    $joined = $args -join ' '
    if ($joined -like 'account show*') {
        if ('SCENARIO' -eq 'tenant') { return '99999999-9999-4999-8999-999999999999' }
        return 'TENANT'
    }
    if ($joined -match '--method POST') {
        $global:posted = $true
        if ('SCENARIO' -eq 'invalid-post-json') { return 'not-json' }
        return '{"id":"new-assignment"}'
    }
    if ($joined -match 'appRoleAssignments/new-assignment') {
        if ('SCENARIO' -eq 'failed-readback') {
            $global:LASTEXITCODE = 1
            return ''
        }
        if ('SCENARIO' -eq 'mismatched-readback') {
            return '{"id":"different-assignment"}'
        }
        return '{"id":"new-assignment","principalId":"PRINCIPAL","resourceId":"RESOURCE","appRoleId":"ROLE"}'
    }
    if ($joined -match 'appRoleAssignments') {
        if ('SCENARIO' -eq 'failed-pregrant') {
            $global:LASTEXITCODE = 1
            return ''
        }
        if ('SCENARIO' -eq 'existing' -or $global:posted) {
            return '{"value":[{"id":"assignment","principalId":"PRINCIPAL","resourceId":"RESOURCE","appRoleId":"ROLE"}]}'
        }
        return '{"value":[]}'
    }
    if ($joined -match '\$filter=') {
        if ('SCENARIO' -eq 'missing') { return '{"value":[]}' }
        return '{"value":[{"id":"RESOURCE","appId":"RESOURCE_APP","appRoles":[{"id":"ROLE","value":"Agent365.Observability.OtelWrite","isEnabled":true,"allowedMemberTypes":["Application"]}]}]}'
    }
    return '{"id":"PRINCIPAL","appId":"APP"}'
}
$failed = $false
$message = ''
$position = ''
try {
    & 'SCRIPT' -TenantId 'TENANT' -AgentPrincipalId 'PRINCIPAL' FLAGS |
        ForEach-Object { $global:emitted += [string]$_ }
}
catch { $failed = $true; $message = $_.Exception.Message; $position = $_.ScriptStackTrace }
$summary = [ordered]@{
    failed=$failed;message=$message;position=$position;posted=$global:posted
    calls=$global:calls;emitted=$global:emitted
} | ConvertTo-Json -Depth 6 -Compress
Write-Output ('RESULT:' + $summary)
"""
        flags = f"-ExpectedAgentAppId '{expected}'"
        if apply:
            flags += " -Apply"
        flags += " " + confirm
        replacements = {"SCENARIO": scenario, "TENANT": TENANT, "PRINCIPAL": PRINCIPAL,
                        "RESOURCE_APP": RESOURCE_APP, "RESOURCE": RESOURCE,
                        "ROLE": ROLE, "APP": APP, "SCRIPT": script, "FLAGS": flags,
                        "CONFIRM_PREFERENCE": confirm_preference}
        for key in sorted(replacements, key=len, reverse=True):
            command = command.replace(key, replacements[key])
        encoded_command = base64.b64encode(command.encode("utf-16-le")).decode()
        result = subprocess.run([POWERSHELL, "-NoProfile", "-EncodedCommand", encoded_command],
                                input=confirmation_answer + "\n",
                                capture_output=True, text=True, timeout=30, cwd=ROOT)
        self.assertEqual(result.returncode, 0, result.stderr)
        summary = next((line[7:] for line in result.stdout.splitlines() if line.startswith("RESULT:")), None)
        self.assertIsNotNone(summary, result.stdout + result.stderr)
        return json.loads(summary)

    def test_preview_never_posts_and_resolves_fixed_application_id(self):
        result = self.run_mock("preview")
        self.assertFalse(result["failed"], result)
        self.assertFalse(result["posted"])
        calls = " ".join(" ".join(call) for call in result["calls"])
        self.assertIn(RESOURCE_APP, calls)
        self.assertNotIn("displayName", calls)

    def test_apply_is_one_narrow_grant_and_removes_body_file(self):
        result = self.run_mock("apply", apply=True)
        self.assertFalse(result["failed"])
        self.assertTrue(result["posted"])
        self.assertEqual(sum("POST" in call for call in result["calls"]), 1)
        receipts = [json.loads(value) for value in result["emitted"]]
        self.assertEqual(receipts[-1]["assignmentId"], "new-assignment")
        self.assertEqual(receipts[-1]["verification"], "confirmed")
        self.assertEqual(list((HOSTED / "generated").glob("grant-body-*.json")), [])

    def test_existing_assignment_is_not_recreated(self):
        result = self.run_mock("existing", apply=True)
        self.assertFalse(result["failed"])
        self.assertFalse(result["posted"])

    def test_wrong_tenant_missing_resource_or_wrong_app_blocks_post(self):
        for scenario, expected in (("tenant", APP), ("missing", APP), ("preview", TENANT)):
            with self.subTest(scenario=scenario):
                result = self.run_mock(scenario, apply=True, expected=expected)
                self.assertTrue(result["failed"])
                self.assertFalse(result["posted"])

    def test_successful_post_and_failed_get_preserves_receipt_and_fails(self):
        result = self.run_mock("failed-readback", apply=True)
        self.assertTrue(result["failed"])
        self.assertTrue(result["posted"])
        self.assertEqual(sum("POST" in call for call in result["calls"]), 1)
        receipt = json.loads(result["emitted"][-1])
        self.assertTrue(receipt["grantMade"])
        self.assertEqual(receipt["assignmentId"], "new-assignment")
        self.assertEqual(receipt["verification"], "incomplete")
        self.assertTrue(receipt["readBackUri"].endswith("/appRoleAssignments/new-assignment"))
        self.assertIn("Grant was made; verification incomplete", result["message"])
        self.assertIn("new-assignment", result["message"])
        self.assertIn(receipt["readBackUri"], result["message"])
        self.assertIn(PRINCIPAL, result["message"])
        self.assertIn(RESOURCE, result["message"])
        self.assertIn(ROLE, result["message"])
        self.assertIn("Do not repeat POST", result["message"])
        self.assertNotIn("No role grant was made", result["message"])
        self.assertEqual(list((HOSTED / "generated").glob("grant-body-*.json")), [])

    def test_failed_pregrant_get_does_not_claim_a_grant(self):
        result = self.run_mock("failed-pregrant", apply=True)
        self.assertTrue(result["failed"])
        self.assertFalse(result["posted"])
        self.assertIn("No role grant was made by this invocation", result["message"])

    def test_invalid_post_receipt_or_mismatched_get_is_not_verified_success(self):
        for scenario in ("invalid-post-json", "mismatched-readback"):
            with self.subTest(scenario=scenario):
                result = self.run_mock(scenario, apply=True)
                self.assertTrue(result["failed"])
                self.assertTrue(result["posted"])
                receipt = json.loads(result["emitted"][-1])
                self.assertTrue(receipt["grantMade"])
                self.assertEqual(receipt["verification"], "incomplete")
                self.assertIn("Do not repeat POST", result["message"])

    def test_apply_requires_explicit_true_confirmation_regardless_of_preference(self):
        for confirm in ("", "-Confirm:$false"):
            for preference in ("None", "High"):
                with self.subTest(confirm=confirm, preference=preference):
                    result = self.run_mock("apply", apply=True, confirm=confirm,
                                           confirm_preference=preference)
                    self.assertTrue(result["failed"])
                    self.assertFalse(result["posted"])
                    self.assertEqual(result["calls"], [])
                    self.assertIn("Apply requires explicit -Confirm", result["message"])

    def test_confirmation_without_apply_is_preview(self):
        result = self.run_mock("preview", confirm="-Confirm")
        self.assertFalse(result["failed"])
        self.assertFalse(result["posted"])

    def test_declined_explicit_confirmation_never_posts(self):
        result = self.run_mock("apply", apply=True, confirmation_answer="N")
        self.assertFalse(result["failed"])
        self.assertFalse(result["posted"])


if __name__ == "__main__":
    unittest.main()
