import base64
import json
from pathlib import Path
import re
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "providers" / "aws" / "Prepare-BedrockDemo.ps1"
TEMPLATE = json.loads((SCRIPT.parent / "bedrock-agent.json").read_text(encoding="utf-8"))
CHANGE_ID = "arn:aws:cloudformation:us-east-1:123456789012:changeSet/a365-test/12345678-1234"
STACK_ID = "arn:aws:cloudformation:us-east-1:123456789012:stack/a365-test/12345678-1234"
TAGS = [{"Key": "Project", "Value": "Agent365SecurityPoC"}, {"Key": "ManagedBy", "Value": "provider-demo"}]


def reply(expected, data=None, text="", code=0):
    return {"expected": expected, "text": json.dumps(data) if data is not None else text, "code": code}


def identity(account="123456789012"):
    return reply("sts get-caller-identity", {"Account": account})


def stack(status="REVIEW_IN_PROGRESS", tags=None):
    return reply("cloudformation describe-stacks", {"Stacks": [{
        "StackId": STACK_ID, "StackName": "a365-test", "StackStatus": status,
        "Tags": TAGS if tags is None else tags,
        "Outputs": [{"OutputKey": "AgentId", "OutputValue": "AGENT12345"}],
    }]})


def change(status="CREATE_COMPLETE", reason="", change_type="CREATE"):
    return reply("cloudformation describe-change-set", {
        "StackId": STACK_ID, "StackName": "a365-test", "ChangeSetId": CHANGE_ID,
        "Status": status, "StatusReason": reason, "ExecutionStatus": "AVAILABLE",
        "Description": "A365 synthetic lab; type=" + change_type, "Tags": TAGS, "Changes": [],
    })


class TemplateTests(unittest.TestCase):
    def test_minimal_resources_no_credentials_or_tools(self):
        resources = TEMPLATE["Resources"]
        self.assertEqual({x["Type"] for x in resources.values()}, {"AWS::IAM::Role", "AWS::Bedrock::Agent"})
        agent = resources["DemoAgent"]["Properties"]
        for forbidden in ("ActionGroups", "KnowledgeBases", "MemoryConfiguration", "AgentCollaborators"):
            self.assertNotIn(forbidden, agent)
        self.assertFalse(agent["SkipResourceInUseCheckOnDelete"])
        self.assertTrue(agent["AutoPrepare"])
        self.assertGreaterEqual(len(agent["Instruction"]), 40)
        self.assertNotIn("Default", TEMPLATE["Parameters"]["FoundationModelId"])
        self.assertNotIn("AccessKey", json.dumps(TEMPLATE))

    def test_role_has_only_one_model_invocation_permission(self):
        role = TEMPLATE["Resources"]["AgentServiceRole"]["Properties"]
        statement = role["Policies"][0]["PolicyDocument"]["Statement"]
        self.assertEqual(len(statement), 1)
        self.assertEqual(statement[0]["Action"], ["bedrock:InvokeModel"])
        self.assertEqual(statement[0]["Resource"], [{
            "Fn::Sub": "arn:${AWS::Partition}:bedrock:${AWS::Region}::foundation-model/${FoundationModelId}"
        }])
        trust = role["AssumeRolePolicyDocument"]["Statement"][0]
        self.assertEqual(trust["Principal"], {"Service": "bedrock.amazonaws.com"})
        self.assertEqual(trust["Action"], "sts:AssumeRole")
        self.assertEqual(trust["Condition"]["StringEquals"]["aws:SourceAccount"], {"Ref": "AWS::AccountId"})
        self.assertIn("${AWS::Region}:${AWS::AccountId}:agent/${TrustedAgentId}", trust["Condition"]["ArnLike"]["AWS:SourceArn"]["Fn::Sub"])

    def test_outputs_and_ownership_tags(self):
        self.assertEqual(TEMPLATE["Outputs"]["AgentId"]["Value"], {"Ref": "DemoAgent"})
        self.assertIn("AccountId", TEMPLATE["Outputs"])
        self.assertIn("Region", TEMPLATE["Outputs"])
        self.assertEqual(TEMPLATE["Resources"]["DemoAgent"]["Properties"]["Tags"]["Data"], "synthetic")

    def test_model_parameter_rejects_profile_arns_and_routing_ids(self):
        pattern = TEMPLATE["Parameters"]["FoundationModelId"]["AllowedPattern"]
        self.assertIsNotNone(re.fullmatch(pattern, "anthropic.claude-haiku-4-5-20251001-v1:0"))
        for model in ("us.anthropic.example-v1:0", "eu.anthropic.example-v1:0",
                      "apac.anthropic.example-v1:0", "global.anthropic.example-v1:0",
                      "profile12345", "arn:aws:bedrock:us-east-1:123456789012:inference-profile/example"):
            with self.subTest(model=model):
                self.assertIsNone(re.fullmatch(pattern, model))


@unittest.skipUnless(shutil.which("powershell"), "Windows PowerShell 5.1 unavailable; JSON tests still run.")
class PowerShellTests(unittest.TestCase):
    def run_script(self, replies, extra="", execute=False, model="example.approved-v1",
                   approved_region="us-east-1", classic="$true", confirm=None,
                   confirm_preference="High", confirmation_answer="Y"):
        encoded = base64.b64encode(json.dumps(replies).encode()).decode()
        wrapper = r"""
$global:Replies = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__REPLIES__')))
$global:Calls = New-Object System.Collections.Generic.List[string]
$global:Arguments = New-Object System.Collections.Generic.List[string]
$global:NextReply = 0
$ConfirmPreference = '__CONFIRM_PREFERENCE__'
function global:Get-Command {
    param($Name, $CommandType, $ErrorAction)
    if ($Name -ne 'aws') { throw 'Unexpected command discovery.' }
    [pscustomobject]@{ Source = 'Invoke-FakeAws' }
}
function global:Invoke-FakeAws {
    $operation = (@($args)[0..1] -join ' ')
    if ($args[1] -eq 'wait') { $operation += ' ' + $args[2] }
    $global:Calls.Add($operation)
    $global:Arguments.Add(($args -join ' '))
    if ($global:NextReply -ge $global:Replies.Count) { throw 'Unexpected AWS call: ' + $operation }
    $next = $global:Replies[$global:NextReply]
    $global:NextReply++
    if ($next.expected -cne $operation) { throw 'Wrong mocked operation: ' + $operation }
    $global:LASTEXITCODE = [int]$next.code
    Write-Output $next.text
}
$result = 0
try {
    & '__SCRIPT__' -StackName a365-test -ExpectedAccountId 123456789012 -Region us-east-1 `
        -ApprovedRegion __APPROVED_REGION__ -ConfirmClassicAccess:__CLASSIC__ __PARAMS__ __CONFIRM__ __EXTRA__
} catch {
    Write-Output ('ERROR: ' + $_.Exception.Message)
    $result = 1
}
Write-Output ('CALLS:' + (ConvertTo-Json -InputObject @($global:Calls) -Compress))
Write-Output ('ARGS:' + (ConvertTo-Json -InputObject @($global:Arguments) -Compress))
exit $result
"""
        parameters = (
            "-Apply -ChangeSetId '" + CHANGE_ID + "'" if execute else
            "-AgentName a365-test -FoundationModel '" + model + "' -Owner lab"
        )
        wrapper = wrapper.replace("__REPLIES__", encoded).replace("__SCRIPT__", str(SCRIPT))
        wrapper = wrapper.replace("__PARAMS__", parameters).replace("__EXTRA__", extra)
        wrapper = wrapper.replace("__APPROVED_REGION__", approved_region).replace("__CLASSIC__", classic)
        if confirm is None:
            confirm = "-Confirm" if execute else "-Confirm:$false"
        wrapper = wrapper.replace("__CONFIRM__", confirm).replace("__CONFIRM_PREFERENCE__", confirm_preference)
        encoded_command = base64.b64encode(wrapper.encode("utf-16-le")).decode()
        flags = [] if execute else ["-NonInteractive"]
        process = subprocess.run(
            ["powershell", "-NoProfile", *flags, "-EncodedCommand", encoded_command],
            input=confirmation_answer + "\n", capture_output=True, text=True, timeout=30, cwd=ROOT,
        )
        output = process.stdout + process.stderr
        calls_line = next((line for line in process.stdout.splitlines() if line.startswith("CALLS:")), None)
        self.assertIsNotNone(calls_line, output)
        return process.returncode, output, json.loads(calls_line[6:])

    def test_whatif_never_calls_aws(self):
        code, out, calls = self.run_script([], extra="-WhatIf")
        self.assertEqual(code, 0, out)
        self.assertEqual(calls, [])
        code, out, calls = self.run_script([], extra="-WhatIf", execute=True)
        self.assertEqual(code, 0, out)
        self.assertEqual(calls, [])

    def test_region_and_classic_gates_are_local(self):
        for kwargs in ({"approved_region": "us-west-2"}, {"classic": "$false"}):
            with self.subTest(kwargs=kwargs):
                code, out, calls = self.run_script([], **kwargs)
                self.assertNotEqual(code, 0, out)
                self.assertEqual(calls, [])

    def test_model_scope_checks_are_local(self):
        for model in ("us.anthropic.example-v1", "global.anthropic.example-v1",
                      "arn:aws:bedrock:us-west-2::foundation-model/example.approved-v1",
                      "arn:aws:bedrock:us-east-1:123456789012:inference-profile/example"):
            with self.subTest(model=model):
                code, out, calls = self.run_script([], model=model)
                self.assertNotEqual(code, 0, out)
                self.assertEqual(calls, [])
        code, out, calls = self.run_script([], extra="-WhatIf",
                                         model="arn:aws:bedrock:us-east-1::foundation-model/example.approved-v1")
        self.assertEqual(code, 0, out)
        self.assertEqual(calls, [])

    def test_account_mismatch_stops_before_cloudformation(self):
        code, out, calls = self.run_script([identity("999999999999")])
        self.assertNotEqual(code, 0)
        self.assertIn("Account mismatch", out)
        self.assertEqual(calls, ["sts get-caller-identity"])

    def test_access_denied_is_not_absence(self):
        code, out, calls = self.run_script([
            identity(), reply("cloudformation describe-stacks", text="AccessDenied", code=254),
        ])
        self.assertNotEqual(code, 0)
        self.assertIn("Refusing to interpret", out)
        self.assertNotIn("cloudformation create-change-set", calls)

    def test_cli_errors_and_invalid_json_are_redacted(self):
        for response in (reply("sts get-caller-identity", text="synthetic-secret", code=254),
                         reply("sts get-caller-identity", text="synthetic-secret")):
            with self.subTest(response=response):
                code, out, calls = self.run_script([response])
                self.assertNotEqual(code, 0, out)
                self.assertIn("suppressed", out)
                self.assertNotIn("synthetic-secret", out)
                self.assertEqual(calls, ["sts get-caller-identity"])

    def prepare_replies(self, final):
        return [
            identity(),
            reply("cloudformation describe-stacks",
                  text="ValidationError: Stack with id a365-test does not exist", code=254),
            reply("cloudformation create-change-set", {"Id": CHANGE_ID}),
            reply("cloudformation wait change-set-create-complete",
                  code=255 if final["code"] or '"FAILED"' in final["text"] else 0),
            final,
        ]

    def test_prepare_success_never_executes(self):
        code, out, calls = self.run_script(self.prepare_replies(change()))
        self.assertEqual(code, 0, out)
        self.assertIn("Review every change", out)
        self.assertNotIn("cloudformation execute-change-set", calls)
        self.assertIn("--cli-connect-timeout 15 --cli-read-timeout 30", out)

    def test_failed_change_set_is_reported_without_execution(self):
        code, out, calls = self.run_script(self.prepare_replies(change("FAILED", "Model access denied")))
        self.assertNotEqual(code, 0)
        self.assertIn("Change set failed", out)
        self.assertNotIn("Model access denied", out)
        self.assertNotIn("cloudformation execute-change-set", calls)

    def test_empty_change_set_is_not_successful_deployment(self):
        code, out, calls = self.run_script(self.prepare_replies(change("FAILED", "The submitted information didn't contain changes.")))
        self.assertEqual(code, 0, out)
        self.assertIn("No changes", out)
        self.assertNotIn("AgentId:", out)
        self.assertNotIn("cloudformation execute-change-set", calls)

    def test_execute_review_in_progress_without_stack_tags(self):
        code, out, calls = self.run_script([
            identity(), stack(tags=[]), change(), identity(),
            reply("cloudformation execute-change-set"),
            reply("cloudformation wait stack-create-complete"), stack("CREATE_COMPLETE"),
        ], execute=True)
        self.assertEqual(code, 0, out)
        self.assertIn("AgentId: AGENT12345", out)
        self.assertEqual(calls.count("sts get-caller-identity"), 2)
        self.assertIn("cloudformation execute-change-set", calls)

    def test_execute_rejects_missing_or_false_explicit_confirmation(self):
        for confirm in ("", "-Confirm:$false"):
            for preference in ("High", "None"):
                with self.subTest(confirm=confirm, preference=preference):
                    code, out, calls = self.run_script(
                        [], execute=True, confirm=confirm, confirm_preference=preference)
                    self.assertNotEqual(code, 0, out)
                    self.assertIn("Execution requires explicit -Confirm", out)
                    self.assertEqual(calls, [])

    def test_explicit_confirmation_retains_shouldprocess_prompt(self):
        for preference in ("High", "None"):
            with self.subTest(preference=preference):
                code, out, calls = self.run_script(
                    [identity(), stack(), change()], execute=True,
                    confirm="-Confirm", confirm_preference=preference, confirmation_answer="N")
                self.assertEqual(code, 0, out)
                self.assertEqual(calls, [
                    "sts get-caller-identity", "cloudformation describe-stacks",
                    "cloudformation describe-change-set",
                ])
                self.assertNotIn("AgentId:", out)

    def test_stack_waiter_failure_does_not_claim_success(self):
        code, out, _ = self.run_script([
            identity(), stack(), change(), identity(),
            reply("cloudformation execute-change-set"),
            reply("cloudformation wait stack-create-complete", code=255), stack("ROLLBACK_COMPLETE"),
        ], execute=True)
        self.assertNotEqual(code, 0)
        self.assertIn("not confirmed successful", out)
        self.assertNotIn("AgentId: AGENT12345", out)

    def test_failed_reviewed_change_set_cannot_execute(self):
        code, out, calls = self.run_script([identity(), stack(), change("FAILED", "Denied")], execute=True)
        self.assertNotEqual(code, 0)
        self.assertNotIn("cloudformation execute-change-set", calls)

    def test_update_pins_existing_agent_trust(self):
        replies = [
            identity(), stack("CREATE_COMPLETE"),
            reply("cloudformation create-change-set", {"Id": CHANGE_ID}),
            reply("cloudformation wait change-set-create-complete"),
            change(change_type="UPDATE"),
        ]
        code, out, calls = self.run_script(replies)
        self.assertEqual(code, 0, out)
        self.assertIn("ParameterKey=TrustedAgentId,ParameterValue=AGENT12345", out)
        self.assertNotIn("cloudformation execute-change-set", calls)
        code, out, calls = self.run_script([identity(), stack("CREATE_COMPLETE")],
                                         extra="-TrustedAgentId '*'")
        self.assertNotEqual(code, 0, out)
        self.assertNotIn("cloudformation create-change-set", calls)

    def test_unowned_stack_or_change_cannot_be_modified(self):
        for execute in (False, True):
            code, out, calls = self.run_script([identity(), stack("CREATE_COMPLETE", tags=[])], execute=execute)
            self.assertNotEqual(code, 0, out)
            self.assertIn("ownership tags", out)
            self.assertEqual(calls, ["sts get-caller-identity", "cloudformation describe-stacks"])
        result = json.loads(change()["text"])
        result["Tags"] = []
        code, out, calls = self.run_script(
            [identity(), stack(), reply("cloudformation describe-change-set", result)], execute=True)
        self.assertNotEqual(code, 0, out)
        self.assertNotIn("cloudformation execute-change-set", calls)

    def test_wrong_change_id_cannot_execute(self):
        result = json.loads(change()["text"])
        result["ChangeSetId"] = CHANGE_ID + "-different"
        code, out, calls = self.run_script(
            [identity(), stack(), reply("cloudformation describe-change-set", result)], execute=True)
        self.assertNotEqual(code, 0, out)
        self.assertIn("Change set ID mismatch", out)
        self.assertNotIn("cloudformation execute-change-set", calls)


if __name__ == "__main__":
    unittest.main()
