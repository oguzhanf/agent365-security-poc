"""Offline template contracts and Windows PowerShell 5.1 lifecycle checks."""

import json
from pathlib import Path
import shutil
import subprocess
import unittest
import uuid


ROOT = Path(__file__).resolve().parents[2]


class InfrastructureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        az = shutil.which("az")
        if not az:
            raise RuntimeError("Azure CLI and the installed Bicep compiler are required.")
        work = ROOT / "scripts" / "azure" / ".work"
        work.mkdir(exist_ok=True)
        output = work / f"test-compiled-{uuid.uuid4().hex}.json"
        try:
            result = subprocess.run(
                [az, "bicep", "build", "--file", str(ROOT / "infra" / "main.bicep"),
                 "--outfile", str(output), "--only-show-errors"],
                cwd=ROOT, capture_output=True, text=True, check=False,
            )
            if result.returncode:
                raise AssertionError(result.stdout + result.stderr)
            cls.template = json.loads(output.read_text(encoding="utf-8-sig"))
            resources = cls.template["resources"]
            if isinstance(resources, dict):
                resources = resources.values()
            cls.resources = {item["type"]: item for item in resources}
        finally:
            output.unlink(missing_ok=True)

    def test_only_real_resource_group_scoped_resources(self):
        self.assertIn("deploymentTemplate", self.template["$schema"])
        self.assertEqual(set(self.resources), {
            "Microsoft.OperationalInsights/workspaces",
            "Microsoft.Insights/components",
            "Microsoft.SecurityInsights/onboardingStates",
            "Microsoft.CognitiveServices/accounts",
            "Microsoft.CognitiveServices/accounts/deployments",
            "Microsoft.Authorization/roleAssignments",
        })
        for resource in self.resources.values():
            self.assertNotIn("preview", resource["apiVersion"])

    def test_observability_is_dedicated_and_keyless(self):
        workspace = self.resources["Microsoft.OperationalInsights/workspaces"]
        self.assertEqual(30, workspace["properties"]["retentionInDays"])
        self.assertEqual("[parameters('dailyQuotaGb')]", workspace["properties"]["workspaceCapping"]["dailyQuotaGb"])
        self.assertTrue(workspace["properties"]["features"]["disableLocalAuth"])
        insights = self.resources["Microsoft.Insights/components"]["properties"]
        self.assertIn("Microsoft.OperationalInsights/workspaces", insights["WorkspaceResourceId"])
        self.assertTrue(insights["DisableLocalAuth"])

    def test_paid_optional_services_default_off(self):
        for parameter in ("enableSentinel", "enableAzureOpenAI"):
            self.assertIs(False, self.template["parameters"][parameter]["defaultValue"])
        for resource_type in ("Microsoft.SecurityInsights/onboardingStates",
                              "Microsoft.CognitiveServices/accounts",
                              "Microsoft.CognitiveServices/accounts/deployments"):
            self.assertIn("condition", self.resources[resource_type])

    def test_openai_requires_entra_and_explicit_network_rules(self):
        account = self.resources["Microsoft.CognitiveServices/accounts"]
        self.assertEqual("OpenAI", account["kind"])
        self.assertTrue(account["properties"]["disableLocalAuth"])
        network = account["properties"]["networkAcls"]
        self.assertEqual("Deny", network["defaultAction"])
        self.assertEqual("None", network["bypass"])
        self.assertIn("approvedIPv4Ranges", json.dumps(network))
        self.assertIn("ipRules", json.dumps(network))
        self.assertEqual([], self.template["parameters"]["approvedIPv4Ranges"]["defaultValue"])
        model = self.resources["Microsoft.CognitiveServices/accounts/deployments"]
        for field, parameter in (("name", "modelName"), ("version", "modelVersion")):
            self.assertEqual(f"[parameters('{parameter}')]", model["properties"]["model"][field])
        self.assertEqual("[parameters('modelSku')]", model["sku"]["name"])
        self.assertEqual("[parameters('modelCapacity')]", model["sku"]["capacity"])
        self.assertEqual("NoAutoUpgrade", model["properties"]["versionUpgradeOption"])

    def test_tags_and_operator_scope(self):
        for resource_type in ("Microsoft.OperationalInsights/workspaces", "Microsoft.Insights/components",
                              "Microsoft.CognitiveServices/accounts", "Microsoft.CognitiveServices/accounts/deployments"):
            self.assertEqual("[variables('labTags')]", self.resources[resource_type]["tags"])
        self.assertEqual("agent365-security-poc", self.template["variables"]["labTags"]["poc"])
        role = self.resources["Microsoft.Authorization/roleAssignments"]
        self.assertIn("operatorPrincipalObjectId", role["condition"])
        self.assertIn("enableAzureOpenAI", role["condition"])
        self.assertIn("Microsoft.CognitiveServices/accounts", role["scope"])
        self.assertEqual("User", role["properties"]["principalType"])
        self.assertEqual("5e0bd9bd-7b93-4f28-af87-19fc36ad61bd", self.template["variables"]["openAIUserRoleId"])
        self.assertEqual("", self.template["parameters"]["operatorPrincipalObjectId"]["defaultValue"])

    def test_outputs_never_export_keys(self):
        for name in self.template["outputs"]:
            self.assertTrue(name.endswith("ResourceId"))
        self.assertNotIn("listKeys", json.dumps(self.template))

    def test_example_matches_parameter_contract(self):
        example = json.loads((ROOT / "infra" / "parameters.example.json").read_text())
        self.assertEqual(set(self.template["parameters"]), set(example["parameters"]))
        self.assertIn("<", example["parameters"]["owner"]["value"])

    def test_powershell_parser_and_mocked_lifecycle(self):
        powershell = shutil.which("powershell")
        self.assertIsNotNone(powershell, "Windows PowerShell 5.1 is required")
        result = subprocess.run(
            [powershell, "-NoProfile", "-NonInteractive", "-File",
             str(ROOT / "tests" / "infra" / "Test-Lifecycle.ps1")],
            cwd=ROOT, capture_output=True, text=True, check=False,
        )
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertIn("Offline lifecycle checks passed", result.stdout)


if __name__ == "__main__":
    unittest.main()
