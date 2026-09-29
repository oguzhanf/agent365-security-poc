import contextlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "managed_agent_demo", ROOT / "providers" / "anthropic" / "managed_agent_demo.py"
)
demo = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(demo)
WORKSPACE = "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ"
AGENT = "agent_011CZkYpogX7uDKUyvBTophP"
ENVIRONMENT = "env_011CZkZ9X2dpNyB7HsEFoRfW"
SESSION = "sesn_011CZkZAtmR3yMPDzynEDxu7"
EVENT = "evt_synthetic123456"
KEY = "sk-ant-synthetic-test-only"


def events(*values, next_page=None):
    return {"data": list(values), "next_page": next_page}


def user_event():
    return {"id": EVENT, "type": "user.message"}


def completed():
    return [
        user_event(),
        {"type": "agent.message", "content": [{"type": "text", "text": "Do not forward me."}]},
        {"type": "session.status_idle", "stop_reason": {"type": "end_turn"}},
    ]


def safe_environment():
    return {
        "id": ENVIRONMENT, "archived_at": None,
        "metadata": {"purpose": "agent365-security-poc", "data": "synthetic"},
        "config": {"type": "cloud", "networking": demo.NETWORK.copy(),
                   "packages": {name: [] for name in ("apt", "cargo", "gem", "go", "npm", "pip")}},
    }


class ManagedAgentTests(unittest.TestCase):
    def invoke(self, argv, environment=None, client=None):
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(demo.os, "environ", environment if environment is not None else {}):
            with patch.object(demo, "Client", return_value=client) if client else contextlib.nullcontext():
                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    code = demo.main(argv)
        return code, stdout.getvalue(), stderr.getvalue()

    def arguments(self, command, *options):
        return [command, "--workspace-id", WORKSPACE, *options]

    def test_all_dry_runs_make_no_connection_or_key_read(self):
        inputs = [
            self.arguments("create-agent", "--model", "claude-sonnet-4-6"),
            self.arguments("create-environment"),
            self.arguments("run", "--agent-id", AGENT, "--environment-id", ENVIRONMENT, "--agent-version", "1"),
            self.arguments("watch", "--session-id", SESSION, "--event-id", EVENT),
            self.arguments("delete-session", "--session-id", SESSION),
            self.arguments("delete-environment", "--environment-id", ENVIRONMENT),
            self.arguments("archive-agent", "--agent-id", AGENT),
        ]
        class NoCredentials(dict):
            def get(self, name, default=None):
                if name == "ANTHROPIC_API_KEY":
                    raise AssertionError("dry-run read credentials")
                return super().get(name, default)
        no_environment = NoCredentials()
        with patch.object(demo.http.client, "HTTPSConnection") as connection:
            for argv in inputs:
                with self.subTest(command=argv[0]):
                    code, out, err = self.invoke(argv, environment=no_environment)
                    self.assertEqual((code, err), (0, ""))
                    self.assertIn('"mode": "dry-run"', out)
                    self.assertIn("[REDACTED: ANTHROPIC_API_KEY]", out)
            connection.assert_not_called()

    def test_invalid_ids_rejected_before_auth_or_http(self):
        for value in ("default", "", "wrkspc_default", "wrkspc_a/b", "wrkspc_test?key=x", "wrkspc_abc\r\nX: y"):
            with self.subTest(value=value), patch.object(demo.http.client, "HTTPSConnection") as connection:
                argv = ["create-environment", "--workspace-id", value, "--apply"]
                code, _, _ = self.invoke(argv)
                self.assertEqual(code, 1)
                connection.assert_not_called()
        for kind in ("agent", "environment", "session"):
            with self.assertRaises(demo.DemoError):
                demo.resource_id("../../another-object", kind)
        with self.assertRaises(demo.DemoError):
            demo.resource_id(SESSION, "agent")

    def test_missing_auth_is_a_failure_without_network(self):
        with patch.object(demo.http.client, "HTTPSConnection") as connection:
            code, _, err = self.invoke(self.arguments("create-environment", "--apply"))
            self.assertEqual(code, 1)
            self.assertIn("ANTHROPIC_API_KEY", err)
            connection.assert_not_called()

    def test_workspace_required(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
            demo.main(["create-environment"])
        self.assertEqual(caught.exception.code, 2)

    def test_minimal_agent_and_environment_bodies(self):
        agent = demo.plans(demo.parser().parse_args(self.arguments("create-agent", "--model", "claude-sonnet-4-6")))[0]
        environment = demo.plans(demo.parser().parse_args(self.arguments("create-environment")))[0]
        self.assertEqual(agent["body"]["tools"], [])
        self.assertEqual(agent["body"]["mcp_servers"], [])
        self.assertEqual(agent["body"]["skills"], [])
        self.assertEqual(environment["body"]["config"]["networking"], demo.NETWORK)
        self.assertNotIn("packages", environment["body"]["config"])

    def test_verified_http_headers_and_exact_payload(self):
        response = Mock(status=200)
        response.read.return_value = b'{"id":"env_011CZkZ9X2dpNyB7HsEFoRfW"}'
        connection = Mock()
        connection.getresponse.return_value = response
        factory = Mock(return_value=connection)
        client = demo.Client(WORKSPACE, KEY, factory)
        self.assertEqual(client.request("POST", "/v1/environments", {"name": "test"})["id"], ENVIRONMENT)
        factory.assert_called_once_with("api.anthropic.com", timeout=15)
        call = connection.request.call_args
        self.assertEqual(call.args, ("POST", "/v1/environments"))
        self.assertEqual(json.loads(call.kwargs["body"]), {"name": "test"})
        self.assertEqual(call.kwargs["headers"]["anthropic-beta"], "managed-agents-2026-04-01")
        self.assertEqual(call.kwargs["headers"]["anthropic-workspace-id"], WORKSPACE)
        self.assertEqual(call.kwargs["headers"]["x-api-key"], KEY)
        connection.close.assert_called_once()

    def test_http_errors_and_redirects_never_echo_or_follow_body(self):
        for status in (301, 400, 401, 403, 429, 500):
            response = Mock(status=status)
            response.read.return_value = json.dumps({"error": KEY}).encode()
            connection = Mock()
            connection.getresponse.return_value = response
            client = demo.Client(WORKSPACE, KEY, Mock(return_value=connection))
            with self.subTest(status=status), self.assertRaises(demo.DemoError) as caught:
                client.request("POST", "/v1/agents", {})
            self.assertIn(str(status), str(caught.exception))
            self.assertNotIn(KEY, str(caught.exception))
            response.read.assert_not_called()
            self.assertEqual(connection.request.call_count, 1)
            connection.close.assert_called_once()

    def test_transport_and_malformed_json_errors_redacted(self):
        with self.assertRaises(demo.DemoError) as caught:
            demo.Client(WORKSPACE, KEY, Mock(side_effect=OSError(KEY))).request("GET", "/v1/agents")
        self.assertNotIn(KEY, str(caught.exception))
        for failure in (OSError(KEY), demo.http.client.HTTPException(KEY)):
            connection = Mock()
            connection.request.side_effect = failure
            with self.assertRaises(demo.DemoError) as caught:
                demo.Client(WORKSPACE, KEY, Mock(return_value=connection)).request("GET", "/v1/sessions/" + SESSION)
            self.assertNotIn(KEY, str(caught.exception))
            connection.close.assert_called_once()
        for payload in (KEY.encode(), b"[]", b"x" * 1048577):
            connection = Mock()
            connection.getresponse.return_value = Mock(status=200, read=Mock(return_value=payload))
            with self.assertRaises(demo.DemoError):
                demo.Client(WORKSPACE, KEY, Mock(return_value=connection)).request("GET", "/v1/sessions/" + SESSION)

    def test_run_is_pinned_and_has_budget(self):
        args = demo.parser().parse_args(self.arguments(
            "run", "--agent-id", AGENT, "--environment-id", ENVIRONMENT, "--agent-version", "2"
        ))
        plan = demo.plans(args)
        self.assertEqual(plan[0]["url"], "https://api.anthropic.com/v1/environments/" + ENVIRONMENT)
        self.assertEqual(plan[1]["body"]["agent"], {"type": "agent", "id": AGENT, "version": 2})
        self.assertEqual(plan[1]["body"]["budget"]["max_list_cost"], {"amount": "50", "currency": "USD"})
        self.assertNotIn("initial_events", plan[1]["body"])
        self.assertEqual(plan[3]["body"]["events"][0]["content"][0]["text"], demo.PROMPT)

    def test_poll_requires_matching_user_message_before_completion(self):
        client = Mock()
        client.request.side_effect = [
            events({"type": "session.status_idle", "stop_reason": {"type": "end_turn"}}),
            events(*completed()),
        ]
        result = demo.poll(client, SESSION, EVENT, max_polls=2, sleep=Mock())
        self.assertEqual(result["status"], "end_turn_observed")
        self.assertEqual(client.request.call_count, 2)
        self.assertNotIn("Do not forward me", json.dumps(result))

    def test_acceptance_is_not_completion_and_polling_is_bounded(self):
        client = Mock()
        client.request.return_value = events(user_event())
        sleep = Mock()
        with self.assertRaises(demo.DemoError) as caught:
            demo.poll(client, SESSION, EVENT, max_polls=3, sleep=sleep)
        self.assertIn("Polling limit reached", str(caught.exception))
        self.assertEqual(client.request.call_count, 3)
        self.assertEqual(sleep.call_count, 2)

    def test_deadline_is_bounded(self):
        client = Mock()
        with self.assertRaises(demo.DemoError):
            demo.poll(client, SESSION, EVENT, clock=Mock(side_effect=[0, 121]))
        client.request.assert_not_called()

    def test_response_after_deadline_does_not_claim_success(self):
        client = Mock()
        client.request.return_value = events(*completed())
        with self.assertRaisesRegex(demo.DemoError, "deadline reached"):
            demo.poll(client, SESSION, EVENT, clock=Mock(side_effect=[0, 1, 121]))
        self.assertEqual(client.request.call_count, 1)

    def test_pagination_followed_and_bounded(self):
        client = Mock()
        client.request.side_effect = [events(user_event(), next_page="cursor/one"), events(*completed()[1:])]
        self.assertEqual(demo.poll(client, SESSION, EVENT)["status"], "end_turn_observed")
        self.assertIn("page=cursor%2Fone", client.request.call_args.args[1])
        client = Mock()
        client.request.side_effect = [events(next_page=str(i)) for i in range(1, 6)]
        with self.assertRaises(demo.DemoError):
            demo.poll(client, SESSION, EVENT)
        self.assertEqual(client.request.call_count, 5)

    def test_error_and_non_successful_idle_propagate(self):
        failing = [
            {"type": "session.error", "error": {"retry_status": {"type": "terminal"}, "message": KEY}},
            {"type": "session.status_terminated"},
            *[{"type": "session.status_idle", "stop_reason": {"type": reason}}
              for reason in ("requires_action", "retries_exhausted", "budget_reached", "unknown")],
        ]
        for event in failing:
            with self.subTest(event=event["type"]):
                client = Mock()
                client.request.return_value = events(user_event(), event)
                with self.assertRaises(demo.DemoError) as caught:
                    demo.poll(client, SESSION, EVENT, sleep=Mock())
                self.assertNotIn(KEY, str(caught.exception))

    def test_completed_run_prints_ids_not_model_output_or_secret(self):
        client = Mock()
        client.request.side_effect = [
            safe_environment(),
            {"id": SESSION},
            {"id": SESSION, "environment_id": ENVIRONMENT, "status": "idle", "vault_ids": [],
             "agent": {"id": AGENT, "version": 1, "system": demo.SYSTEM,
                       "tools": [], "skills": [], "mcp_servers": [], "multiagent": None}},
            {"data": [user_event()]},
            events(*completed()),
        ]
        code, out, err = self.invoke(self.arguments(
            "run", "--agent-id", AGENT, "--environment-id", ENVIRONMENT,
            "--agent-version", "1", "--apply"
        ), { "ANTHROPIC_API_KEY": KEY }, client)
        self.assertEqual((code, err), (0, ""))
        self.assertIn("accepted_not_complete", out)
        self.assertIn("end_turn_observed", out)
        self.assertNotIn(KEY, out)
        self.assertNotIn("Do not forward me", out)
        self.assertEqual([call.args[:2] for call in client.request.call_args_list], [
            ("GET", "/v1/environments/" + ENVIRONMENT),
            ("POST", "/v1/sessions"),
            ("GET", "/v1/sessions/" + SESSION),
            ("POST", "/v1/sessions/" + SESSION + "/events"),
            ("GET", "/v1/sessions/" + SESSION + "/events?order=asc&limit=100"),
        ])

    def test_unsafe_environment_never_creates_a_session(self):
        environments = []
        for field, value in (("allowed_hosts", ["example.com"]), ("allow_mcp_servers", True),
                             ("allow_package_managers", True), ("type", "unrestricted")):
            environment = safe_environment()
            environment["config"]["networking"][field] = value
            environments.append(environment)
        environment = safe_environment()
        environment["config"]["packages"]["pip"] = ["unapproved-package"]
        environments.append(environment)
        environment = safe_environment()
        environment["metadata"] = {}
        environments.append(environment)
        for environment in environments:
            with self.subTest(environment=environment):
                client = Mock()
                client.request.return_value = environment
                code, _, err = self.invoke(self.arguments(
                    "run", "--agent-id", AGENT, "--environment-id", ENVIRONMENT,
                    "--agent-version", "1", "--apply"
                ), {"ANTHROPIC_API_KEY": KEY}, client)
                self.assertEqual(code, 1)
                self.assertIn("No session was created", err)
                self.assertEqual(client.request.call_count, 1)

    def test_unsafe_session_is_not_sent_an_event(self):
        client = Mock()
        client.request.side_effect = [safe_environment(), {"id": SESSION}, {
            "id": SESSION, "environment_id": ENVIRONMENT, "status": "idle", "vault_ids": [], "agent": {
            "id": AGENT, "version": 1, "system": demo.SYSTEM,
            "tools": [{"type": "agent_toolset_20260401"}], "skills": [], "mcp_servers": [],
        }}]
        code, out, err = self.invoke(self.arguments(
            "run", "--agent-id", AGENT, "--environment-id", ENVIRONMENT,
            "--agent-version", "1", "--apply"
        ), {"ANTHROPIC_API_KEY": KEY}, client)
        self.assertEqual(code, 1)
        self.assertIn(SESSION, out)
        self.assertIn("No event was sent", err)
        self.assertEqual(client.request.call_count, 3)

    def test_cleanup_is_exact_and_archive_is_not_delete(self):
        client = Mock()
        client.request.return_value = {"id": AGENT, "archived_at": "2026-09-18T00:00:00Z"}
        code, out, _ = self.invoke(self.arguments("archive-agent", "--agent-id", AGENT, "--apply"),
                                  {"ANTHROPIC_API_KEY": KEY}, client)
        self.assertEqual(code, 0)
        self.assertEqual(client.request.call_args.args[:2], ("POST", "/v1/agents/" + AGENT + "/archive"))
        self.assertIn("archived_not_deleted", out)
        client.request.return_value = {"id": SESSION, "type": "session_deleted"}
        code, _, _ = self.invoke(self.arguments("delete-session", "--session-id", SESSION, "--apply"),
                                {"ANTHROPIC_API_KEY": KEY}, client)
        self.assertEqual(code, 0)
        self.assertEqual(client.request.call_args.args[:2], ("DELETE", "/v1/sessions/" + SESSION))
        client.request.return_value = {"id": ENVIRONMENT, "type": "environment_deleted"}
        code, _, _ = self.invoke(self.arguments("delete-environment", "--environment-id", ENVIRONMENT, "--apply"),
                                {"ANTHROPIC_API_KEY": KEY}, client)
        self.assertEqual(code, 0)
        self.assertEqual(client.request.call_args.args[:2], ("DELETE", "/v1/environments/" + ENVIRONMENT))

    def test_cleanup_rejects_unconfirmed_or_wrong_resource(self):
        for command, option, identifier, response in (
            ("delete-session", "--session-id", SESSION, {"id": SESSION, "type": "session"}),
            ("delete-session", "--session-id", SESSION,
             {"id": "sesn_different12345", "type": "session_deleted"}),
            ("delete-environment", "--environment-id", ENVIRONMENT,
             {"id": ENVIRONMENT, "type": "environment"}),
            ("archive-agent", "--agent-id", AGENT, {"id": AGENT, "archived_at": None}),
        ):
            with self.subTest(command=command, response=response):
                client = Mock()
                client.request.return_value = response
                code, out, err = self.invoke(self.arguments(command, option, identifier, "--apply"),
                                            {"ANTHROPIC_API_KEY": KEY}, client)
                self.assertEqual(code, 1)
                self.assertIn("did not confirm", err)
                self.assertNotIn('"status": "deleted"', out)


if __name__ == "__main__":
    unittest.main()
