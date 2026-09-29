"""Standard-library tests. Every test blocks socket and DNS operations."""

import base64
import copy
import io
import json
import os
from pathlib import Path
import socket
import stat
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from types import SimpleNamespace
from unittest.mock import Mock, patch
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs

from runtime import agent, auth, model, safety, sdk_export, telemetry, tools
from runtime.__main__ import main

TENANT = "11111111-1111-4111-8111-111111111111"
BLUEPRINT = "22222222-2222-4222-8222-222222222222"
AGENT = "33333333-3333-4333-8333-333333333333"
OTHER = "44444444-4444-4444-8444-444444444444"
NOW = 1_800_000_000
SECRET = "synthetic-unit-test-secret"


def jwt(**overrides):
    claims = {
        "tid": TENANT, "iss": f"https://sts.windows.net/{TENANT}/",
        "aud": auth.OBSERVABILITY_APP, "appid": AGENT,
        "roles": [auth.OBSERVABILITY_ROLE], "exp": NOW + 3600,
    }
    claims.update(overrides)
    encoded = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"test.{encoded}.not-a-real-signature"


def token_response(token=None, **overrides):
    result = {"access_token": token or jwt(), "expires_in": 3600, "token_type": "Bearer"}
    result.update(overrides)
    return result


def tool_call(name="read_fixture", arguments='{"name":"public-procedure.txt"}', call_id="call_1"):
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": arguments}}


def completion(content=None, calls=None):
    return {"role": "assistant", "content": content, "tool_calls": calls}


class OfflineTest(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.dict(os.environ, {}, clear=True))
        for target in ("socket.socket.connect", "socket.socket.connect_ex", "socket.socket.sendto",
                       "socket.create_connection", "socket.getaddrinfo"):
            self.enterContext(patch(target, side_effect=AssertionError("Network access prohibited in tests.")))

    def error(self, fn, *args, **kwargs):
        with self.assertRaises(safety.PocError) as caught:
            fn(*args, **kwargs)
        self.assertNotIn(SECRET, str(caught.exception))
        return str(caught.exception)


class SafetyTests(OfflineTest):
    def test_guid_is_canonical(self):
        self.assertEqual(safety.guid(TENANT.upper()), TENANT)

    def test_guid_rejects_invalid_values(self):
        for value in ("", None, 3, "common", "organizations", "{" + TENANT + "}",
                      "00000000-0000-0000-0000-000000000000", TENANT + "/x"):
            with self.subTest(value=value):
                self.error(safety.guid, value)

    def test_required_environment(self):
        for value in ("", " "):
            with patch.dict(os.environ, {"REQUIRED": value}):
                self.error(safety.required_env, "REQUIRED")
        with patch.dict(os.environ, {"REQUIRED": "present"}):
            self.assertEqual(safety.required_env("REQUIRED"), "present")

    def test_isolation_disables_all_implicit_paths(self):
        with patch.dict(os.environ, {"ENABLE_A365_OBSERVABILITY_EXPORTER": "true",
                                     "ENABLE_SENSITIVE_DATA": "true"}):
            safety.isolate_environment()
            for name in ("MICROSOFT_OTEL_SDKSTATS_DISABLED", "APPLICATIONINSIGHTS_STATSBEAT_DISABLED_ALL",
                         "A365_SUPPRESS_INVOKE_AGENT_INPUT"):
                self.assertEqual(os.environ[name], "true")
            self.assertEqual(os.environ["ENABLE_A365_OBSERVABILITY_EXPORTER"], "false")
            self.assertEqual(os.environ["ENABLE_SENSITIVE_DATA"], "false")

    def test_isolation_rejects_inherited_exporters_and_authority(self):
        for name in ("OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_RESOURCE_ATTRIBUTES", "OTEL_PYTHON_TRACER_PROVIDER",
                     "APPLICATIONINSIGHTS_CONNECTION_STRING", "A365_OBSERVABILITY_DOMAIN_OVERRIDE",
                     "A365_OBSERVABILITY_SCOPE_OVERRIDE", "AZURE_AUTHORITY_HOST", "OTEL_TRACES_SAMPLER"):
            with self.subTest(name=name), patch.dict(os.environ, {name: SECRET}):
                self.error(safety.isolate_environment)

    def test_transport_tls_and_proxy_configuration(self):
        with patch("urllib.request.build_opener") as build, patch("ssl.create_default_context") as tls:
            safety.Https()
            tls.assert_called_once()
            handlers = build.call_args.args
            self.assertEqual(handlers[0].proxies, {})
            self.assertIsInstance(handlers[2], safety.NoRedirect)

    def test_transport_rejects_invalid_destinations_before_request(self):
        opener = Mock()
        http = safety.Https(opener)
        for url in ("http://login.microsoftonline.com/x", "https://evil.invalid/x",
                    "https://login.microsoftonline.com.evil.invalid/x", "https://user:secret@login.microsoftonline.com/",
                    "https://login.microsoftonline.com:444/x", "https://login.microsoftonline.com:bad/x",
                    "https://login.microsoftonline.com/x#secret", "https://a.openai.azure.com\n/x",
                    "https://127.0.0.1/x", "https://a.b.openai.azure.com/x", None):
            with self.subTest(url=url):
                self.error(http.post, url, b"{}", {})
        opener.open.assert_not_called()

    def test_timeout_bounds(self):
        for value in (0, 31, True, float("nan"), "20", None):
            self.error(safety.Https, timeout=value)

    def response(self, body=b"{}", status=200, url="https://login.microsoftonline.com/token"):
        response = Mock(status=status)
        response.geturl.return_value = url
        response.read.return_value = body
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        opener = Mock()
        opener.open.return_value = response
        return safety.Https(opener), response

    def test_transport_success_is_bounded(self):
        http, response = self.response()
        self.assertEqual(http.post_json("https://login.microsoftonline.com/token", b"{}", {}), {})
        response.read.assert_called_once_with(262145)
        self.assertEqual(http.opener.open.call_args.kwargs["timeout"], 20)

    def test_transport_request_and_response_size(self):
        http, _ = self.response(b"x" * 11)
        self.error(http.post, "https://login.microsoftonline.com/token", b"{}", {}, limit=10)
        self.error(http.post, "https://login.microsoftonline.com/token", b"x" * 524289, {})
        self.error(http.post, "https://login.microsoftonline.com/token", "not-bytes", {})

    def test_transport_no_redirect_even_same_host(self):
        for code in (301, 302, 303, 307, 308):
            body = io.BytesIO(SECRET.encode())
            self.error(safety.NoRedirect().redirect_request, None, body, code, "", {}, "https://evil.invalid")
            self.assertTrue(body.closed)
        http, _ = self.response(url="https://login.microsoftonline.com/other")
        self.error(http.post, "https://login.microsoftonline.com/token", b"{}", {})

    def test_transport_http_error_does_not_echo_body(self):
        error_body = io.BytesIO(SECRET.encode())
        error = HTTPError("https://login.microsoftonline.com/token", 403, SECRET, {}, error_body)
        http = safety.Https(Mock(open=Mock(side_effect=error)))
        message = self.error(http.post, error.url, b"{}", {})
        self.assertIn("403", message)
        self.assertTrue(error_body.closed)

    def test_transport_network_errors_are_safe(self):
        for error in (URLError(SECRET), TimeoutError(SECRET), OSError(SECRET), ValueError(SECRET)):
            http = safety.Https(Mock(open=Mock(side_effect=error)))
            self.error(http.post, "https://login.microsoftonline.com/token", b"{}", {})

    def test_transport_rejects_invalid_json(self):
        for body in (b"[]", b"null", b"\xff", SECRET.encode(), b"[" * 2000):
            http, _ = self.response(body)
            self.error(http.post_json, "https://login.microsoftonline.com/token", b"{}", {})


class AuthTests(OfflineTest):
    def resolver(self, results=None):
        self.http = Mock()
        self.http.post_json.side_effect = results or [
            token_response(jwt(aud="api://AzureADTokenExchange", appid=BLUEPRINT)),
            token_response(),
        ]
        self.clock = [100]
        return auth.BlueprintS2STokenResolver(
            TENANT, BLUEPRINT, AGENT, SECRET, http=self.http,
            monotonic=lambda: self.clock[0], wall_clock=lambda: NOW,
        )

    def test_two_stage_fmi_payloads_and_public_authority(self):
        resolver = self.resolver()
        self.assertEqual(resolver(AGENT, TENANT), jwt())
        calls = self.http.post_json.call_args_list
        first = parse_qs(calls[0].args[1].decode())
        second = parse_qs(calls[1].args[1].decode())
        self.assertEqual(first, {
            "grant_type": ["client_credentials"], "client_id": [BLUEPRINT], "client_secret": [SECRET],
            "scope": ["api://AzureADTokenExchange/.default"], "fmi_path": [AGENT],
        })
        self.assertEqual(second["client_id"], [AGENT])
        self.assertEqual(second["scope"], [auth.OBSERVABILITY_SCOPE])
        self.assertEqual(second["client_assertion_type"], ["urn:ietf:params:oauth:client-assertion-type:jwt-bearer"])
        self.assertEqual(second["client_assertion"], [jwt(aud="api://AzureADTokenExchange", appid=BLUEPRINT)])
        self.assertNotIn("client_secret", second)
        for call in calls:
            self.assertEqual(call.args[0], f"https://login.microsoftonline.com/{TENANT}/oauth2/v2.0/token")
            self.assertEqual(call.kwargs["limit"], 65536)

    def test_single_identity_is_enforced_before_auth(self):
        resolver = self.resolver()
        for agent_id, tenant_id in ((OTHER, TENANT), (AGENT, OTHER), ("common", TENANT)):
            self.error(resolver, agent_id, tenant_id)
        self.http.post_json.assert_not_called()

    def test_configuration_is_validated(self):
        for tenant, blueprint, agent_id, secret in (
            ("common", BLUEPRINT, AGENT, SECRET), (TENANT, AGENT, AGENT, SECRET),
            (TENANT, BLUEPRINT, AGENT, ""), (TENANT, BLUEPRINT, AGENT, "x" * 8193),
        ):
            self.error(auth.BlueprintS2STokenResolver, tenant, blueprint, agent_id, secret)

    def test_single_entry_cache_reuses_token(self):
        resolver = self.resolver()
        for _ in range(5):
            resolver(AGENT, TENANT)
        self.assertEqual(self.http.post_json.call_count, 2)
        self.assertEqual(resolver._expires_at, 3700)

    def test_cache_refreshes_before_expiry(self):
        resolver = self.resolver()
        resolver(AGENT, TENANT)
        self.clock[0] = 3640
        self.http.post_json.side_effect = [
            token_response(jwt(aud="api://AzureADTokenExchange")), token_response(),
        ]
        resolver(AGENT, TENANT)
        self.assertEqual(self.http.post_json.call_count, 4)

    def test_cache_uses_shorter_claim_expiry(self):
        resolver = self.resolver([
            token_response(jwt(aud="api://AzureADTokenExchange")),
            token_response(jwt(exp=NOW + 120)),
        ])
        resolver(AGENT, TENANT)
        self.assertEqual(resolver._expires_at, 220)

    def test_clear_invalidates_secret_and_cache(self):
        resolver = self.resolver()
        resolver(AGENT, TENANT)
        resolver.clear()
        self.assertIsNone(resolver._token)
        self.assertEqual(resolver._secret, "")
        self.error(resolver, AGENT, TENANT)
        self.assertEqual(self.http.post_json.call_count, 2)

    def test_lifetime_is_finite_positive_and_bounded(self):
        self.assertEqual(auth.lifetime("3600"), 3600)
        for value in (None, "", True, 0, -1, 86401, float("inf"), float("nan"), SECRET):
            self.error(auth.lifetime, value)

    def test_bad_token_responses_are_safe(self):
        for overrides in ({"access_token": None}, {"access_token": " "}, {"access_token": "x" * 32769},
                          {"token_type": None}, {"token_type": "Basic"}, {"expires_in": -1},
                          {"access_token": SECRET}):
            resolver = self.resolver([token_response(**overrides)])
            self.error(resolver, AGENT, TENANT)
            self.assertEqual(self.http.post_json.call_count, 1)

    def test_exchange_token_audience_and_expiry_are_checked(self):
        for overrides in ({"aud": auth.OBSERVABILITY_APP}, {"aud": "api://AzureADTokenExchangeUSGov"},
                          {"aud": "api://AzureADTokenExchange", "exp": NOW - 1},
                          {"aud": "api://AzureADTokenExchange", "tid": OTHER}):
            resolver = self.resolver([token_response(jwt(**overrides))])
            self.error(resolver, AGENT, TENANT)
            self.assertEqual(self.http.post_json.call_count, 1)

    def test_resource_claims_accept_v1_v2_audiences(self):
        for audience in (auth.OBSERVABILITY_APP, f"api://{auth.OBSERVABILITY_APP}"):
            token = jwt(aud=audience, azp=AGENT, iss=f"https://login.microsoftonline.com/{TENANT}/v2.0")
            self.assertEqual(auth.check_resource_claims(token, TENANT, AGENT, NOW), 3600)

    def test_resource_claims_fail_closed(self):
        for overrides in ({"aud": "https://graph.microsoft.com"}, {"tid": OTHER},
                          {"appid": BLUEPRINT}, {"azp": BLUEPRINT}, {"roles": []},
                          {"roles": auth.OBSERVABILITY_ROLE}, {"scp": ""}, {"exp": NOW},
                          {"exp": float("nan")}, {"exp": True}, {"nbf": NOW + 1},
                          {"nbf": float("inf")}, {"iss": f"https://login.microsoftonline.us/{TENANT}/v2.0"}):
            with self.subTest(overrides=overrides):
                self.error(auth.check_resource_claims, jwt(**overrides), TENANT, AGENT, NOW)

    def test_resource_claims_reject_non_jwt(self):
        for token in ("opaque", "a.b.c", "a.@@@.c", None, "a." + "eA" * 20000 + ".c"):
            self.error(auth.check_resource_claims, token, TENANT, AGENT, NOW)

    def test_failed_refresh_does_not_reuse_stale_token(self):
        resolver = self.resolver()
        resolver(AGENT, TENANT)
        self.clock[0] = 5000
        self.http.post_json.side_effect = safety.PocError("Auth failed; body withheld.")
        self.error(resolver, AGENT, TENANT)
        self.assertIsNone(resolver._token)


class ModelTests(OfflineTest):
    def client(self):
        self.enterContext(patch("runtime.model.time.time", return_value=NOW))
        self.credential = Mock()
        self.credential.get_token.return_value = SimpleNamespace(
            token=jwt(aud="https://ai.azure.com"), expires_on=NOW + 3600
        )
        self.http = Mock()
        self.http.post_json.return_value = {
            "choices": [{"finish_reason": "stop", "message": completion("safe")}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5},
        }
        return model.AzureOpenAI("https://test.openai.azure.com", "deployment", TENANT,
                                credential=self.credential, http=self.http)

    def test_model_urls_are_exact(self):
        self.assertEqual(model.model_url("https://test.openai.azure.com/", "model", "v1"),
                         "https://test.openai.azure.com/openai/v1/chat/completions")
        self.assertEqual(model.model_url("https://test.openai.azure.com", "model", "2024-10-21"),
                         "https://test.openai.azure.com/openai/deployments/model/chat/completions?api-version=2024-10-21")

    def test_model_endpoint_rejections(self):
        for endpoint in ("http://test.openai.azure.com", "https://evil.invalid",
                         "https://test.openai.azure.com.evil.invalid", "https://a.b.openai.azure.com",
                         "https://test.openai.azure.com/path", "https://test.openai.azure.com?x=1",
                         "https://test.openai.azure.com#x", "https://user@test.openai.azure.com",
                         "https://test.openai.azure.com:444", "https://test.openai.azure.com:bad",
                         "https://localhost", "https://test.openai.azure.com\n", None):
            self.error(model.model_url, endpoint, "deployment", "v1")

    def test_model_deployment_and_api_version_validation(self):
        for deployment, api in (("../escape", "v1"), ("", "v1"), ("x", "v1&evil=true"),
                                ("x", "2024-10-21-preview"), ("x" * 65, "v1")):
            self.error(model.model_url, "https://test.openai.azure.com", deployment, api)

    def test_model_uses_separate_azure_cli_audience(self):
        client = self.client()
        message, counts = client.complete([], tools.TOOL_SCHEMA)
        self.credential.get_token.assert_called_once_with(model.MODEL_SCOPE, tenant_id=TENANT)
        request = self.http.post_json.call_args
        self.assertEqual(request.args[2]["Authorization"], "Bearer " + self.credential.get_token.return_value.token)
        body = json.loads(request.args[1])
        self.assertEqual(body["max_completion_tokens"], 800)
        self.assertFalse(body["stream"])
        self.assertEqual(message["content"], "safe")
        self.assertEqual(counts, {"prompt_tokens": 10, "completion_tokens": 5})

    def test_model_bad_credentials_do_not_send(self):
        client = self.client()
        for token in (
            SimpleNamespace(token=jwt(), expires_on=NOW + 3600),
            SimpleNamespace(token=jwt(aud="https://ai.azure.com", tid=OTHER), expires_on=NOW + 3600),
            SimpleNamespace(token=SECRET, expires_on=NOW),
            SimpleNamespace(token=SECRET, expires_on=float("nan")), object(),
        ):
            self.credential.get_token.return_value = token
            self.error(client.complete, [], [])
        self.http.post_json.assert_not_called()

    def test_model_auth_errors_are_redacted(self):
        client = self.client()
        self.credential.get_token.side_effect = ValueError(SECRET)
        self.error(client.complete, [], [])

    def test_dated_model_api_uses_legacy_audience(self):
        self.client()
        self.credential.get_token.return_value.token = jwt(aud="https://cognitiveservices.azure.com")
        client = model.AzureOpenAI("https://test.openai.azure.com", "deployment", TENANT,
                                  api_version="2024-10-21", credential=self.credential, http=self.http)
        client.complete([], [])
        self.credential.get_token.assert_called_once_with(model.LEGACY_MODEL_SCOPE, tenant_id=TENANT)

    def test_model_input_bound_before_authentication(self):
        client = self.client()
        self.error(client.complete, [{"content": "x" * 65536}], [])
        self.credential.get_token.assert_not_called()

    def test_model_malformed_responses(self):
        client = self.client()
        for result in ({}, {"choices": []}, {"choices": [{}, {}]}, {"choices": [None]},
                       {"choices": [{"finish_reason": "length", "message": completion(SECRET)}]},
                       {"choices": [{"finish_reason": "stop", "message": {"role": "user", "content": SECRET}}]},
                       {"choices": [{"finish_reason": "tool_calls", "message": completion(SECRET)}]},
                       {"choices": [{"finish_reason": "stop", "message": completion(None, [tool_call()])}]}):
            self.http.post_json.return_value = result
            self.error(client.complete, [], [])

    def test_model_usage_bounds(self):
        client = self.client()
        for value in (True, -1, 1000001, SECRET):
            self.http.post_json.return_value["usage"]["prompt_tokens"] = value
            self.error(client.complete, [], [])


class AgentTests(OfflineTest):
    def runner(self, *messages):
        return Mock(complete=Mock(side_effect=[(message, {}) for message in messages]))

    def test_real_loop_reads_fixture_then_returns_metadata_only(self):
        runner = self.runner(completion(None, [tool_call()]), completion("Approval POC-APPROVAL-6142"))
        result = agent.run_agent(runner, "approval")
        self.assertEqual(result["model_rounds"], 2)
        self.assertTrue(result["approved_reference_present"])
        self.assertNotIn("answer", result)
        self.assertEqual(result["guard"], "application_logic_not_microsoft_enforcement")
        self.assertTrue(result["tool_decisions"][0]["allowed"])

    def test_restricted_tool_result_denied(self):
        runner = self.runner(completion(None, [tool_call(arguments='{"name":"restricted-record.txt"}')]),
                             completion("Denied"))
        result = agent.run_agent(runner, "restricted")
        self.assertFalse(result["tool_decisions"][0]["allowed"])
        self.assertEqual(result["tool_decisions"][0]["reason"], "application_policy")

    def test_unsupported_tool_denied_without_dispatching_code(self):
        runner = self.runner(completion(None, [tool_call("run_shell", SECRET)]), completion("Denied"))
        result = agent.run_agent(runner, "approval")
        self.assertEqual(result["tool_decisions"], [
            {"tool": "unapproved_tool", "allowed": False, "reason": "unknown_tool"}
        ])
        self.assertNotIn(SECRET, json.dumps(result))

    def test_max_turns_is_a_hard_bound(self):
        runner = self.runner(*(completion(None, [tool_call(call_id=f"c{i}")]) for i in range(6)))
        self.error(agent.run_agent, runner, "approval", max_rounds=2)
        self.assertEqual(runner.complete.call_count, 2)

    def test_invalid_scenario_and_rounds(self):
        for scenario, rounds in (("unknown", 2), ("approval", 0), ("approval", 7),
                                 ("approval", True), ("approval", 1.5)):
            runner = Mock()
            self.error(agent.run_agent, runner, scenario, rounds)
            runner.complete.assert_not_called()

    def test_malformed_messages(self):
        for message in (None, [], completion(None), completion(" "), completion("x" * 8193),
                        completion("\ud800"), completion("ok", {}),
                        completion("ok", "tools"), completion(None, [tool_call()] * 5)):
            self.error(agent.run_agent, self.runner(message), "approval")

    def test_invalid_tool_calls(self):
        invalid = [None, {}, {"type": "not-function"}, tool_call(call_id="../escape"),
                   tool_call(call_id=""), tool_call(arguments="x" * 1025), tool_call(arguments="\ud800")]
        for call in invalid:
            self.error(agent.run_agent, self.runner(completion(None, [call])), "approval")

    def test_duplicate_tool_ids_rejected_before_second_execution(self):
        runner = self.runner(completion(None, [tool_call()]), completion(None, [tool_call()]))
        with patch("runtime.agent.dispatch", wraps=tools.dispatch) as dispatch:
            self.error(agent.run_agent, runner, "approval")
            self.assertEqual(dispatch.call_count, 1)

    def test_model_failure_stays_a_failure(self):
        runner = Mock(complete=Mock(side_effect=safety.PocError("Model rejected; body withheld.")))
        self.error(agent.run_agent, runner, "approval")

    def test_injection_stays_untrusted_data(self):
        snapshots = []
        messages = [completion(None, [tool_call(arguments='{"name":"untrusted-instruction.txt"}')]),
                    completion("POC_UNTRUSTED_OK")]

        def complete(history, schema):
            snapshots.append(copy.deepcopy(history))
            return messages.pop(0), {}

        result = agent.run_agent(SimpleNamespace(complete=complete), "injection")
        self.assertTrue(result["untrusted_marker_present"])
        self.assertEqual(snapshots[0][0]["role"], "system")
        tool_message = snapshots[1][-1]
        self.assertEqual(tool_message["role"], "tool")
        self.assertIn("untrusted_data", json.loads(tool_message["content"]))
        self.assertNotIn("Microsoft enforcement", json.dumps(result))


class FixtureTests(OfflineTest):
    def test_public_and_untrusted_fixture_integrity(self):
        for name in ("public-procedure.txt", "untrusted-instruction.txt"):
            result = tools.read_fixture(name)
            self.assertTrue(result["allowed"], result)
            self.assertTrue(result["synthetic"])

    def test_restricted_denied_before_file_access(self):
        with patch.object(Path, "open", side_effect=AssertionError("Must not read")):
            self.assertEqual(tools.read_fixture("restricted-record.txt"), tools.denied("application_policy"))

    def test_paths_are_an_exact_allowlist(self):
        for name in ("../public-procedure.txt", "..\\public-procedure.txt", "C:\\secret",
                     "\\\\host\\share", "public-procedure.txt:secret", ".env", "test-prompts.json",
                     "PUBLIC-PROCEDURE.TXT", "public-procedure.txt/", None):
            self.assertEqual(tools.read_fixture(name), tools.denied("invalid_fixture"))

    def test_unknown_tools_are_denied(self):
        self.assertEqual(tools.dispatch("delete", "{}"), tools.denied("unknown_tool"))

    def test_arguments_are_small_and_exact(self):
        for arguments in (None, "x" * 1025, "\ud800", "not-json", "[]", '{"name":"public-procedure.txt","path":"x"}',
                          "{}", '{"name":["public-procedure.txt"]}'):
            self.assertFalse(tools.dispatch("read_fixture", arguments)["allowed"])

    def test_reparse_and_symlink_detection(self):
        for info in (SimpleNamespace(st_mode=stat.S_IFLNK, st_file_attributes=0),
                     SimpleNamespace(st_mode=stat.S_IFREG, st_file_attributes=1024)):
            self.assertTrue(tools._reparse(info))

    def test_directory_junction_is_rejected(self):
        with patch.object(Path, "lstat", return_value=SimpleNamespace(st_mode=stat.S_IFDIR, st_file_attributes=1024)):
            self.assertEqual(tools.read_fixture("public-procedure.txt"), tools.denied("unsafe_fixture"))

    def test_parent_junction_is_rejected(self):
        original = Path.lstat

        def lstat(path):
            if path == tools.FIXTURES.parent:
                return SimpleNamespace(st_mode=stat.S_IFDIR, st_file_attributes=1024)
            return original(path)

        with patch.object(Path, "lstat", lstat):
            self.assertEqual(tools.read_fixture("public-procedure.txt"), tools.denied("unsafe_fixture"))

    def test_leaf_symlink_and_oversize_are_rejected(self):
        original = Path.lstat
        for info in (SimpleNamespace(st_mode=stat.S_IFLNK, st_size=20, st_file_attributes=0),
                     SimpleNamespace(st_mode=stat.S_IFREG, st_size=8193, st_file_attributes=0)):
            def lstat(path):
                return info if path.name == "public-procedure.txt" else original(path)
            with patch.object(Path, "lstat", lstat):
                self.assertEqual(tools.read_fixture("public-procedure.txt"), tools.denied("unsafe_fixture"))

    def test_opened_file_identity_and_type_are_checked(self):
        info = SimpleNamespace(st_mode=stat.S_IFREG, st_size=10, st_ino=-1, st_dev=-1)
        with patch("os.fstat", return_value=info):
            self.assertEqual(tools.read_fixture("public-procedure.txt"), tools.denied("unsafe_fixture"))

    def test_fixture_hash_is_enforced(self):
        with patch.dict(tools.HASHES, {"public-procedure.txt": "0" * 64}):
            self.assertEqual(tools.read_fixture("public-procedure.txt"), tools.denied("fixture_integrity"))

    def test_missing_fixture_is_safe(self):
        with patch.object(Path, "lstat", side_effect=OSError(SECRET)):
            self.assertEqual(tools.read_fixture("public-procedure.txt"), tools.denied("unavailable_fixture"))


class ExportTests(OfflineTest):
    def session(self, body=b"{}"):
        self.http = Mock(post=Mock(return_value=body))
        return sdk_export.StrictAgent365Session(TENANT, AGENT, self.http)

    def send(self, session):
        return session.post(session.url, b"{}", {"authorization": "Bearer synthetic"}, 10)

    def test_strict_export_session_preserves_exact_destination(self):
        session = self.session()
        response = self.send(session)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(session.sent, 1)
        self.assertFalse(session.failed)
        self.assertEqual(self.http.post.call_args.args[0], session.url)

    def test_strict_export_rejects_destination_before_auth_leak(self):
        session = self.session()
        self.error(session.post, "https://evil.invalid", b"{}", {"authorization": "Bearer " + SECRET}, 10)
        self.http.post.assert_not_called()
        self.assertTrue(session.failed)

    def test_strict_export_headers_and_timeout(self):
        for headers, timeout in (({}, 10), ({"authorization": "Bearer "}, 10),
                                 ({"authorization": "Bearer a\nb"}, 10),
                                 ({"authorization": "Basic secret"}, 10),
                                 ({"authorization": "Bearer safe"}, 31)):
            session = self.session()
            self.error(session.post, session.url, b"{}", headers, timeout)
            self.http.post.assert_not_called()

    def test_successful_routing_is_not_ingestion_proof(self):
        for body in (b"", b"{}", b'{"partialSuccess":{"rejectedSpans":0,"errorMessage":""}}',
                     b'{"results":[{"sinks":{"a":{"status":"sent"},"b":{"status":"not_routed"}}}]}'):
            session = self.session(body)
            self.send(session)
            self.assertEqual(session.sent, 1)
            self.assertFalse(hasattr(session, "ingestion_verified"))

    def test_partial_and_per_destination_rejection_are_failures(self):
        for body in (
            b'{"partialSuccess":{"rejectedSpans":1}}',
            b'{"partialSuccess":{"errorMessage":"synthetic-unit-test-secret"}}',
            b'{"error":"synthetic-unit-test-secret"}', b"[]", b"not-json",
            b'{"partialSuccess":{"rejectedSpans":0},"results":[{"sinks":{"a":{"status":"rejected"}}}]}',
            b'{"results":[{"sinks":{"a":{"status":"not_routed"}}}]}',
            b'{"results":[{"sinks":{"a":{"status":"unknown"}}}]}', b'{"results":[]}',
        ):
            session = self.session(body)
            self.error(self.send, session)
            self.assertTrue(session.failed)
            self.assertEqual(session.sent, 0)


class TelemetryUnitTests(OfflineTest):
    def modules(self):
        class Result:
            SUCCESS = 0
            FAILURE = 1

        modules = {
            "opentelemetry.sdk.trace": SimpleNamespace(ReadableSpan=lambda **kwargs: SimpleNamespace(**kwargs)),
            "opentelemetry.trace": SimpleNamespace(Status=lambda code: SimpleNamespace(status_code=code)),
            "opentelemetry.sdk.util.instrumentation": SimpleNamespace(
                InstrumentationScope=lambda *args: SimpleNamespace(name=args[0], version=args[1])
            ),
            "opentelemetry.sdk.trace.export": SimpleNamespace(SpanExporter=object, SpanExportResult=Result),
        }
        self.enterContext(patch.dict(sys.modules, modules))
        return Result

    def span(self):
        return SimpleNamespace(
            name=SECRET, context="context", parent=None, resource=SECRET,
            attributes={"gen_ai.operation.name": "invoke_agent", "microsoft.tenant.id": TENANT,
                        "microsoft.a365.agent.blueprint.id": BLUEPRINT, "gen_ai.agent.id": AGENT,
                        "gen_ai.input.messages": SECRET, "gen_ai.output.messages": SECRET,
                        "gen_ai.tool.arguments": SECRET, "gen_ai.tool.result": SECRET,
                        "user.email": SECRET, "server.address": SECRET},
            events=[SECRET], links=[SECRET], kind=1, status=SimpleNamespace(status_code=2, description=SECRET),
            start_time=1, end_time=2, instrumentation_scope=SECRET,
        )

    def test_metadata_filter_preserves_actual_sdk_identity_keys(self):
        self.modules()
        span = telemetry.metadata_span(self.span(), {"service.name": "poc"})
        self.assertEqual(span.attributes["microsoft.tenant.id"], TENANT)
        self.assertEqual(span.attributes["microsoft.a365.agent.blueprint.id"], BLUEPRINT)
        self.assertEqual(span.attributes["gen_ai.agent.id"], AGENT)
        self.assertTrue(set(span.attributes) <= telemetry.METADATA_KEYS)

    def test_metadata_filter_strips_content_and_other_channels(self):
        self.modules()
        span = telemetry.metadata_span(self.span(), {"service.name": "poc"})
        self.assertNotIn(SECRET, repr(vars(span)))
        self.assertEqual(span.name, "invoke_agent")
        self.assertEqual(span.events, ())
        self.assertEqual(span.links, ())
        self.assertFalse(hasattr(span.status, "description"))

    def test_pinned_sdk_chat_operation_is_normalized(self):
        self.modules()
        span = self.span()
        span.attributes["gen_ai.operation.name"] = "Chat"
        clean = telemetry.metadata_span(span, {})
        self.assertEqual(clean.name, "chat")
        self.assertEqual(clean.attributes["gen_ai.operation.name"], "chat")

    def test_unknown_operation_is_not_exported(self):
        self.modules()
        span = self.span()
        span.attributes["gen_ai.operation.name"] = SECRET
        self.error(telemetry.metadata_span, span, {})

    def test_checked_exporter_tracks_delegate_failures(self):
        result = self.modules()
        delegate = Mock(export=Mock(return_value=result.FAILURE))
        exporter = telemetry.checked_exporter(delegate, {})
        self.assertEqual(exporter.export([self.span()]), result.FAILURE)
        self.assertTrue(exporter.failed)
        self.assertEqual(exporter.count, 1)

    def test_checked_exporter_records_safe_exceptions(self):
        result = self.modules()
        delegate = Mock(export=Mock(side_effect=OSError(SECRET)))
        exporter = telemetry.checked_exporter(delegate, {})
        self.assertEqual(exporter.export([self.span()]), result.FAILURE)
        self.assertTrue(exporter.failed)

    def test_flush_success_never_asserts_ingestion(self):
        instance = telemetry.Telemetry.__new__(telemetry.Telemetry)
        instance.provider = Mock(force_flush=Mock(return_value=True))
        instance.exporter = SimpleNamespace(failed=False, count=3)
        instance.session = SimpleNamespace(failed=False, sent=1)
        instance.resolver = object()
        instance.trace_id = "1" * 32
        instance.conversation_id = "synthetic"
        result = instance.finish()
        self.assertFalse(result["ingestion_verified"])
        self.assertEqual(result["telemetry"], "export_attempted_ingestion_unverified")

    def test_flush_or_http_failure_cannot_pass(self):
        instance = telemetry.Telemetry.__new__(telemetry.Telemetry)
        instance.provider = Mock(force_flush=Mock(return_value=True))
        instance.exporter = SimpleNamespace(failed=True, count=3)
        instance.session = None
        self.error(instance.finish)


class CliTests(OfflineTest):
    def invoke(self, arguments):
        output, errors = io.StringIO(), io.StringIO()
        with redirect_stdout(output), redirect_stderr(errors):
            code = main(arguments)
        return code, output.getvalue(), errors.getvalue()

    def test_default_runs_without_sdk_credentials_or_network(self):
        with patch("runtime.model.AzureOpenAI", side_effect=AssertionError("No model")), \
                patch("runtime.telemetry.Telemetry", side_effect=AssertionError("No SDK")), \
                patch("runtime.auth.BlueprintS2STokenResolver", side_effect=AssertionError("No auth")):
            code, output, errors = self.invoke([])
        self.assertEqual(code, 0, errors)
        result = json.loads(output)
        self.assertFalse(result["model_called"])
        self.assertFalse(result["ingestion_verified"])
        self.assertEqual(result["telemetry"], "disabled")

    def test_default_poisoned_exporter_environment_cannot_enable_network(self):
        with patch.dict(os.environ, {
            "ENABLE_A365_OBSERVABILITY_EXPORTER": "true",
            "OTEL_EXPORTER_OTLP_ENDPOINT": "https://evil.invalid",
            "A365_OBSERVABILITY_DOMAIN_OVERRIDE": "https://evil.invalid",
            "APPLICATIONINSIGHTS_CONNECTION_STRING": SECRET,
            "A365_BLUEPRINT_CLIENT_SECRET": SECRET,
        }), patch("runtime.telemetry.Telemetry", side_effect=AssertionError("No SDK")), \
                patch("runtime.auth.BlueprintS2STokenResolver", side_effect=AssertionError("No auth")), \
                patch("runtime.model.AzureOpenAI", side_effect=AssertionError("No model")):
            code, output, errors = self.invoke([])
        self.assertEqual(code, 0, errors)
        self.assertEqual(json.loads(output)["mode"], "local_simulation")
        self.assertNotIn(SECRET, output)

    def test_export_needs_explicit_model_flag(self):
        code, _, errors = self.invoke(["--export-agent365"])
        self.assertEqual(code, 2)
        self.assertIn("requires --live-model", errors)

    def test_model_options_need_flag(self):
        code, _, _ = self.invoke(["--endpoint", "https://test.openai.azure.com"])
        self.assertEqual(code, 2)

    def test_instrumentation_refuses_poisoned_environment(self):
        with patch.dict(os.environ, {"OTEL_EXPORTER_OTLP_ENDPOINT": SECRET}):
            code, _, errors = self.invoke(["--instrument"])
        self.assertEqual(code, 2)
        self.assertNotIn(SECRET, errors)

    def test_live_model_requires_configuration(self):
        code, _, errors = self.invoke(["--live-model"])
        self.assertEqual(code, 2)
        self.assertIn("required runtime environment", errors)

    def live_environment(self):
        return {
            "MODEL_TENANT_ID": TENANT, "AZURE_OPENAI_ENDPOINT": "https://test.openai.azure.com",
            "AZURE_OPENAI_DEPLOYMENT": "model", "A365_TENANT_ID": TENANT,
            "A365_BLUEPRINT_ID": BLUEPRINT, "A365_AGENT_ID": AGENT,
            "A365_BLUEPRINT_CLIENT_SECRET": SECRET,
        }

    def test_export_auth_fails_before_model_and_clears_secret(self):
        runner = Mock(tenant_id=TENANT)
        resolver = Mock(tenant_id=TENANT, agent_id=AGENT,
                        side_effect=safety.PocError("Agent role absent; body withheld."))
        with patch.dict(os.environ, self.live_environment()), \
                patch("runtime.model.AzureOpenAI", return_value=runner), \
                patch("runtime.auth.BlueprintS2STokenResolver", return_value=resolver):
            code, _, errors = self.invoke(["--live-model", "--export-agent365"])
            self.assertNotIn("A365_BLUEPRINT_CLIENT_SECRET", os.environ)
        self.assertEqual(code, 2)
        self.assertNotIn(SECRET, errors)
        runner.complete.assert_not_called()
        resolver.clear.assert_called_once()

    def test_export_rejects_cross_tenant_before_token_request(self):
        resolver = Mock(tenant_id=OTHER, agent_id=AGENT)
        with patch.dict(os.environ, self.live_environment()), \
                patch("runtime.model.AzureOpenAI", return_value=Mock(tenant_id=TENANT)), \
                patch("runtime.auth.BlueprintS2STokenResolver", return_value=resolver):
            code, _, errors = self.invoke(["--live-model", "--export-agent365"])
        self.assertEqual(code, 2)
        self.assertIn("tenant IDs must match", errors)
        resolver.assert_not_called()
        resolver.clear.assert_called_once()


if __name__ == "__main__":
    unittest.main()
