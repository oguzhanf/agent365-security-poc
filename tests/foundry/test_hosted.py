import asyncio
import base64
import contextvars
import importlib.util
import json
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
import sys
from types import SimpleNamespace as NS
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "hosted_foundry" / "src"
sys.path.insert(0, str(SRC))
from poc_hosted.application import FoundryModel, HostedApplication, RequestRejected, SYNTHETIC_INPUT
from poc_hosted.identity import ObservabilityTokenResolver, inspect_sdk_token, platform_credential
from poc_hosted.limits import RequestBodyLimit
from poc_hosted.settings import ConfigurationError, OBSERVABILITY_APP_ID, OBSERVABILITY_ROLE, OBSERVABILITY_SCOPE, Settings, prepare_environment
from poc_hosted.telemetry import OperationFailed, Telemetry, configure, safe_scope

TENANT = "11111111-1111-4111-8111-111111111111"
AGENT = "22222222-2222-4222-8222-222222222222"
ENV = {
    "FOUNDRY_PROJECT_ENDPOINT": "https://synthetic.services.ai.azure.com/api/projects/lab",
    "FOUNDRY_AGENT_NAME": "synthetic-agent",
    "FOUNDRY_AGENT_VERSION": "1",
    "FOUNDRY_AGENT_SESSION_ID": "session-test",
    "AZURE_AI_MODEL_DEPLOYMENT_NAME": "operator-approved-existing-model",
}


def settings(export=False):
    return Settings.from_env(dict(ENV, POC_A365_EXPORT=str(export).lower(),
                                  A365_TENANT_ID=TENANT, A365_AGENT_ID=AGENT))


def load_entry_point():
    spec = importlib.util.spec_from_file_location("hosted_entry_point", SRC / "main.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sdk_token(**changes):
    claims = dict(aud=OBSERVABILITY_APP_ID, tid=TENANT, appid=AGENT,
                  exp=4102444800, roles=[OBSERVABILITY_ROLE], idtyp="app")
    claims.update(changes)
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).rstrip(b"=").decode()
    return NS(token=f"test.{payload}.sdk-result-not-a-signature", expires_on=4102444800)


class SettingsAndIdentityTests(unittest.TestCase):
    def test_default_is_export_off_before_identity_exists(self):
        value = Settings.from_env(ENV)
        self.assertFalse(value.export)
        self.assertEqual(value.agent_id, "")
        self.assertEqual(value.tenant_id, "")

    def test_explicit_opt_in_needs_both_ids(self):
        with self.assertRaises(ConfigurationError):
            Settings.from_env(dict(ENV, POC_A365_EXPORT="true"))
        for value in ("yes", "1", "unexpected"):
            with self.subTest(value=value), self.assertRaises(ConfigurationError):
                Settings.from_env(dict(ENV, POC_A365_EXPORT=value))

    def test_reject_unapproved_endpoint_or_missing_model(self):
        for endpoint in ("http://bad", "https://bad.invalid/api/projects/x",
                         "https://user@x.services.ai.azure.com/api/projects/x",
                         "https://x.services.ai.azure.com/api/projects/x?secret=1"):
            with self.subTest(endpoint=endpoint), self.assertRaises(ConfigurationError):
                Settings.from_env(dict(ENV, FOUNDRY_PROJECT_ENDPOINT=endpoint))
        with self.assertRaises(ConfigurationError):
            Settings.from_env(dict(ENV, AZURE_AI_MODEL_DEPLOYMENT_NAME=""))

    def test_no_inherited_exporters_or_self_telemetry(self):
        for key in ("OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_PYTHON_DISTRO",
                    "A365_OBSERVABILITY_DOMAIN_OVERRIDE", "AZURE_TOKEN_CREDENTIALS"):
            with self.subTest(key=key), self.assertRaises(ConfigurationError):
                prepare_environment({key: "unsafe"}, False)
        env = {"APPLICATIONINSIGHTS_CONNECTION_STRING": "platform injected"}
        prepare_environment(env, False)
        self.assertEqual(env["MICROSOFT_OTEL_SDKSTATS_DISABLED"], "true")
        self.assertEqual(env["APPLICATIONINSIGHTS_STATSBEAT_DISABLED_ALL"], "true")
        self.assertEqual(env["ENABLE_A365_OBSERVABILITY_EXPORTER"], "false")
        self.assertEqual(env["APPLICATIONINSIGHTS_CONNECTION_STRING"], "platform injected")

    def test_no_developer_or_secret_credential_fallback(self):
        factory = Mock()
        self.assertIs(platform_credential(factory), factory.return_value)
        flags = factory.call_args.kwargs
        for key in ("environment", "cli", "powershell", "developer_cli", "shared_token_cache",
                    "visual_studio_code", "interactive_browser", "broker"):
            self.assertIs(flags[f"exclude_{key}_credential"], True)
        self.assertFalse(flags["exclude_managed_identity_credential"])
        self.assertFalse(flags["exclude_workload_identity_credential"])

    def test_matching_trusted_sdk_result_and_azp(self):
        value = sdk_token()
        self.assertEqual(inspect_sdk_token(value, TENANT, AGENT, now=100), value.token)
        self.assertTrue(inspect_sdk_token(sdk_token(azp=AGENT, aud=f"api://{OBSERVABILITY_APP_ID}"),
                                         TENANT, AGENT, now=100))

    def test_mismatch_delegation_roles_expiry_fail_closed(self):
        for changes in ({"aud": "https://graph.microsoft.com"}, {"tid": AGENT},
                        {"appid": TENANT}, {"azp": TENANT}, {"roles": []},
                        {"idtyp": "user"}, {"scp": "user_impersonation"}, {"exp": 20},
                        {"exp": float("nan")}, {"exp": float("inf")}):
            with self.subTest(changes=changes), self.assertRaises(ConfigurationError):
                inspect_sdk_token(sdk_token(**changes), TENANT, AGENT, now=100)
        for token in ("not.jwt", "a.@@@@.b", "a." + "x" * 33000 + ".b"):
            with self.subTest(token=token[:20]), self.assertRaises(ConfigurationError):
                inspect_sdk_token(NS(token=token, expires_on=4102444800), TENANT, AGENT)

    def test_resolver_uses_fixed_scope_and_rechecks_each_sdk_result(self):
        credential = Mock()
        credential.get_token.return_value = sdk_token()
        resolver = ObservabilityTokenResolver(credential, settings(True))
        self.assertTrue(resolver(AGENT, TENANT))
        credential.get_token.assert_called_once_with(OBSERVABILITY_SCOPE)
        credential.get_token.return_value = sdk_token(appid=TENANT)
        with self.assertRaises(ConfigurationError):
            resolver(AGENT, TENANT)
        credential.get_token.reset_mock()
        with self.assertRaises(ConfigurationError):
            resolver(TENANT, TENANT)
        credential.get_token.assert_not_called()


class FakeScope:
    def __init__(self):
        self.errors = []
        self.cancelled = False
        self.exited_with = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.exited_with = args[0]

    def record_error(self, error):
        self.errors.append(error)

    def record_cancellation(self):
        self.cancelled = True


class BodyLimitTests(unittest.IsolatedAsyncioTestCase):
    async def test_chunks_over_limit_do_not_reach_host(self):
        messages = iter([
            {"type": "http.request", "body": b"x" * 2000, "more_body": True},
            {"type": "http.request", "body": b"x" * 2100, "more_body": False},
        ])
        async def receive():
            return next(messages)
        sent = []
        async def send(message):
            sent.append(message)
        app = Mock(side_effect=AssertionError("host must not be called"))
        await RequestBodyLimit(app)({"type": "http", "method": "POST"}, receive, send)
        self.assertEqual(sent[0]["status"], 413)
        app.assert_not_called()

    async def test_valid_body_replayed_once_and_disconnect_forwarded(self):
        messages = iter([
            {"type": "http.request", "body": b"small", "more_body": False},
            {"type": "http.disconnect"},
        ])
        async def receive():
            return next(messages)
        async def app(scope, receive, send):
            self.assertEqual((await receive())["body"], b"small")
            self.assertEqual((await receive())["type"], "http.disconnect")
        await RequestBodyLimit(app)({"type": "http", "method": "POST"}, receive, Mock())


class ScopeTests(unittest.TestCase):
    def test_exception_content_does_not_reach_sdk_scope(self):
        scope = FakeScope()
        with self.assertRaisesRegex(OperationFailed, "Synthetic operation failed"):
            with safe_scope(scope):
                raise RuntimeError("SECRET prompt and HTTP authorization")
        self.assertIsNone(scope.exited_with)
        self.assertNotIn("SECRET", repr(scope.errors))
        self.assertIsNone(scope.errors[0].__traceback__)

    def test_cancellation_is_not_a_success(self):
        scope = FakeScope()
        with self.assertRaises(asyncio.CancelledError):
            with safe_scope(scope):
                raise asyncio.CancelledError("PRIVATE")
        self.assertTrue(scope.cancelled)
        self.assertIsNone(scope.exited_with)
        self.assertEqual(scope.errors, [])

    def test_sdk_requests_have_only_metadata_and_tool_shares_request(self):
        root, tool = FakeScope(), FakeScope()
        core = NS(AgentDetails=lambda **kw: NS(**kw), Request=lambda **kw: NS(**kw),
                  InvokeAgentScopeDetails=lambda: NS(), ToolCallDetails=lambda **kw: NS(**kw),
                  InvokeAgentScope=NS(start=Mock(return_value=root)),
                  ExecuteToolScope=NS(start=Mock(return_value=tool)))
        trace = NS(get_current_span=lambda: NS(get_span_context=lambda: NS(is_valid=True, trace_id=23)))
        context = NS(Context=lambda: object(), attach=Mock(return_value="clean"), detach=Mock())
        telemetry = Telemetry(settings(), Mock(), core, trace, context)
        with telemetry.invocation("chain-actual", "session-actual") as trace_id:
            with telemetry.tool():
                value = 2 + 3
        self.assertEqual(value, 5)
        self.assertEqual(trace_id, "00000000000000000000000000000017")
        invocation = core.InvokeAgentScope.start.call_args
        tool_call = core.ExecuteToolScope.start.call_args
        request = invocation.args[0]
        self.assertEqual(vars(request), {"conversation_id": "chain-actual", "session_id": "session-actual"})
        self.assertIs(request, tool_call.args[0])
        self.assertEqual(vars(tool_call.args[1]), {"tool_name": "synthetic_add"})
        self.assertEqual(invocation.kwargs, {})
        self.assertEqual(tool_call.kwargs, {})
        context.detach.assert_called_once_with("clean")
        with self.assertRaises(OperationFailed):
            with telemetry.tool():
                pass


class RecordingTelemetry:
    def __init__(self):
        self.context = contextvars.ContextVar("test_scope", default=None)
        self.invocations = []
        self.tools = []

    @contextmanager
    def invocation(self, conversation, session):
        token = self.context.set(conversation)
        self.invocations.append((conversation, session))
        try:
            with safe_scope(FakeScope()):
                yield "a" * 32
        finally:
            self.context.reset(token)

    @contextmanager
    def tool(self):
        self.tools.append(self.context.get())
        yield


def request():
    return NS(input=SYNTHETIC_INPUT, store=False)


def context(chain="chain-1"):
    async def get_input_text():
        return SYNTHETIC_INPUT
    return NS(get_input_text=get_input_text, conversation_chain_id=chain,
              shutdown=asyncio.Event(), platform_context=NS(call_id=f"opaque-{chain}"))


class FakeModel:
    def __init__(self):
        self.calls = []
        self.entered = asyncio.Event()
        self.release = None
        self.failure = None
        self.cancelled = False

    async def run(self, prompt, call_id):
        self.calls.append((prompt, call_id))
        self.entered.set()
        try:
            if self.release:
                await self.release.wait()
            if self.failure:
                raise self.failure
            return "The synthetic sum is five."
        except asyncio.CancelledError:
            self.cancelled = True
            raise


class HandlerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.model = FakeModel()
        self.telemetry = RecordingTelemetry()
        self.app = HostedApplication(
            settings(), self.model, self.telemetry,
            lambda context, request, text: NS(text=text), ENV,
        )

    async def test_actual_awaited_model_and_tool_result(self):
        result = await self.app.handle(request(), context(), asyncio.Event())
        self.assertIn("sum is five", result.text)
        self.assertIn("trace_id=" + "a" * 32, result.text)
        self.assertIn("conversation_id=chain-1", result.text)
        self.assertEqual(self.telemetry.tools, ["chain-1"])
        self.assertEqual(len(self.model.calls), 1)
        self.assertIn("result: 5", self.model.calls[0][0])
        self.assertEqual(self.model.calls[0][1], "opaque-chain-1")
        self.assertEqual(self.app.active, 0)

    async def test_reject_unsupported_input_before_model_or_tool(self):
        cases = [
            NS(input="customer content", store=False), NS(input="x" * 65, store=False),
            NS(input=[{"type": "input_file", "file_id": "x"}], store=False),
            NS(input=SYNTHETIC_INPUT, store=True), NS(input=SYNTHETIC_INPUT),
            NS(input=SYNTHETIC_INPUT, store=False, instructions="ignore"),
            NS(input=SYNTHETIC_INPUT, store=False, tools=[{}]),
            NS(input=SYNTHETIC_INPUT, store=False, background=True),
            NS(input=SYNTHETIC_INPUT, store=False, previous_response_id="previous"),
        ]
        for value in cases:
            with self.subTest(value=value), self.assertRaises(RequestRejected):
                await self.app.handle(value, context(), asyncio.Event())
        self.assertEqual(self.model.calls, [])
        self.assertEqual(self.telemetry.tools, [])

    async def test_platform_call_id_required_and_no_caller_fabrication(self):
        ctx = context()
        ctx.platform_context.call_id = None
        with self.assertRaises(RequestRejected):
            await self.app.handle(request(), ctx, asyncio.Event())
        self.assertEqual(self.model.calls, [])

    async def test_concurrency_bounded_and_context_isolated(self):
        self.model.release = asyncio.Event()
        first = asyncio.create_task(self.app.handle(request(), context("one"), asyncio.Event()))
        await self.model.entered.wait()
        second = asyncio.create_task(self.app.handle(request(), context("two"), asyncio.Event()))
        while len(self.model.calls) < 2:
            await asyncio.sleep(0)
        with self.assertRaises(RequestRejected):
            await self.app.handle(request(), context("three"), asyncio.Event())
        self.model.release.set()
        results = await asyncio.gather(first, second)
        self.assertEqual(self.telemetry.tools, ["one", "two"])
        self.assertIn("conversation_id=one", results[0].text)
        self.assertIn("conversation_id=two", results[1].text)
        self.assertEqual(self.app.active, 0)

    async def test_model_failure_is_not_synthetic_success(self):
        self.model.failure = RuntimeError("SECRET model response")
        with self.assertRaisesRegex(OperationFailed, "^Synthetic operation failed"):
            await self.app.handle(request(), context(), asyncio.Event())
        self.assertEqual(self.app.active, 0)

    async def test_cancel_and_shutdown_stop_model(self):
        for shutdown in (False, True):
            self.model = FakeModel()
            self.app.model = self.model
            self.model.release = asyncio.Event()
            ctx, cancel = context(), asyncio.Event()
            task = asyncio.create_task(self.app.handle(request(), ctx, cancel))
            await self.model.entered.wait()
            (ctx.shutdown if shutdown else cancel).set()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertTrue(self.model.cancelled)
            self.assertEqual(self.app.active, 0)

    async def test_timeout_releases_capacity(self):
        self.app.settings = replace(settings(), timeout_seconds=0.02)
        self.model.release = asyncio.Event()
        with self.assertRaises(TimeoutError):
            await self.app.handle(request(), context(), asyncio.Event())
        self.assertTrue(self.model.cancelled)
        self.assertEqual(self.app.active, 0)

    async def test_response_length_bound(self):
        async def huge(*args):
            return "x" * 2049
        self.model.run = huge
        with self.assertRaises(OperationFailed):
            await self.app.handle(request(), context(), asyncio.Event())

    async def test_pinned_model_adapter_awaits_agent_and_forwards_call_only(self):
        captured = {}
        class Agent:
            def __init__(self, **kwargs):
                captured["agent"] = kwargs
            async def __aenter__(self):
                return self
            async def __aexit__(self, *args):
                captured["closed"] = True
            async def run(self, prompt, **kwargs):
                captured["run"] = (prompt, kwargs)
                return NS(text="real awaited fake result")
        client = Mock(return_value="client")
        with patch.dict(sys.modules, {
            "agent_framework": NS(Agent=Agent),
            "agent_framework.foundry": NS(FoundryChatClient=client),
            "azure.ai.agentserver.core.platform_headers": NS(FOUNDRY_CALL_ID="x-agent-foundry-call-id"),
        }):
            value = await FoundryModel(settings(), "platform-credential").run("synthetic prompt", "opaque")
        self.assertEqual(value, "real awaited fake result")
        self.assertEqual(captured["agent"]["default_options"], {"store": False, "max_tokens": 256})
        self.assertEqual(captured["run"][1], {"client_kwargs": {"extra_headers": {"x-agent-foundry-call-id": "opaque"}}})
        self.assertEqual(client.call_args.kwargs["credential"], "platform-credential")
        self.assertTrue(captured["closed"])


def telemetry_modules(exporter):
    providers = []
    class Proxy:
        pass
    class Provider:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            self.processors = []
            providers.append(self)
        def add_span_processor(self, processor):
            self.processors.append(processor)
        def get_tracer(self, *args, **kwargs):
            return "scope tracer"
        def shutdown(self):
            self.closed = True
        def force_flush(self, **kwargs):
            return True
    trace = NS(ProxyTracerProvider=Proxy, get_tracer_provider=lambda: Proxy(),
               set_tracer_provider=Mock(), NoOpTracer=lambda: "no-op")
    metrics = NS(set_meter_provider=Mock(), NoOpMeterProvider=Mock())
    core = NS(AgentDetails=lambda **kwargs: NS(**kwargs))
    modules = {
        "opentelemetry": NS(context=NS(), metrics=metrics, trace=trace),
        "opentelemetry._logs": NS(NoOpLoggerProvider=Mock(), set_logger_provider=Mock()),
        "opentelemetry.sdk.resources": NS(Resource=lambda attrs: attrs),
        "opentelemetry.sdk.trace": NS(TracerProvider=Provider),
        "opentelemetry.sdk.trace.sampling": NS(ALWAYS_ON="always-on"),
        "opentelemetry.sdk.trace.export": NS(BatchSpanProcessor=lambda target, **kw: (target, kw)),
        "microsoft.opentelemetry.a365": NS(core=core),
        "microsoft.opentelemetry.a365.core.exporters.agent365_exporter": NS(_Agent365Exporter=exporter),
    }
    return modules, providers, trace


class ExportIsolationTests(unittest.TestCase):
    def test_off_never_creates_exporter_or_acquires_token(self):
        exporter, credential = Mock(), Mock()
        modules, providers, trace = telemetry_modules(exporter)
        with patch.dict(sys.modules, modules):
            value = configure(settings(), credential)
        exporter.assert_not_called()
        credential.get_token.assert_not_called()
        self.assertEqual(providers[0].processors, [])
        self.assertEqual(providers[0].get_tracer("Agent365Sdk"), "scope tracer")
        self.assertEqual(providers[0].get_tracer("Azure.AI.AgentServer.Responses"), "no-op")
        self.assertEqual(providers[0].get_tracer("agent_framework"), "no-op")
        self.assertTrue(value.close())
        self.assertTrue(providers[0].closed)
        trace.set_tracer_provider.assert_called_once_with(providers[0])

    def test_on_preflights_identity_before_exporter_with_storage_disabled(self):
        exporter, credential = Mock(), Mock()
        credential.get_token.return_value = sdk_token()
        modules, providers, _ = telemetry_modules(exporter)
        with patch.dict(sys.modules, modules):
            configure(settings(True), credential)
        credential.get_token.assert_called_once_with(OBSERVABILITY_SCOPE)
        self.assertIs(exporter.call_args.kwargs["enable_durable_delivery"], False)
        self.assertIs(exporter.call_args.kwargs["use_s2s_endpoint"], True)
        self.assertEqual(len(providers[0].processors), 1)
        self.assertEqual(providers[0].kwargs["resource"], {"service.name": "a365-hosted-synthetic"})

    def test_identity_failure_prevents_exporter_and_provider_install(self):
        exporter, credential = Mock(), Mock()
        credential.get_token.return_value = sdk_token(appid=TENANT)
        modules, providers, trace = telemetry_modules(exporter)
        with patch.dict(sys.modules, modules), self.assertRaises(ConfigurationError):
            configure(settings(True), credential)
        exporter.assert_not_called()
        trace.set_tracer_provider.assert_not_called()
        self.assertTrue(providers[0].closed)

    def test_existing_provider_is_rejected(self):
        exporter = Mock()
        modules, providers, trace = telemetry_modules(exporter)
        trace.get_tracer_provider = lambda: object()
        with patch.dict(sys.modules, modules), self.assertRaises(ConfigurationError):
            configure(settings(), Mock())
        self.assertEqual(providers, [])

    def test_main_import_has_no_sdk_or_server_side_effect(self):
        with patch("poc_hosted.identity.platform_credential", side_effect=AssertionError("auth forbidden")):
            main = load_entry_point()
            self.assertTrue(callable(main.create_app))

    def test_host_composition_disables_platform_auto_export_and_storage(self):
        main = load_entry_point()
        host, telemetry, credential = Mock(), Mock(), Mock()
        host.response_handler = lambda handler: handler
        host_class = Mock(return_value=host)
        modules = {
            "agent_framework.observability": NS(disable_instrumentation=Mock()),
            "azure.ai.agentserver.responses": NS(
                InMemoryResponseProvider=lambda: "memory-only",
                ResponsesAgentServerHost=host_class,
                ResponsesServerOptions=lambda **kwargs: kwargs, TextResponse=Mock(),
            ),
        }
        with patch.dict(sys.modules, modules), patch.dict("os.environ", ENV, clear=True), \
             patch.object(main, "platform_credential", return_value=credential), \
             patch.object(main, "configure", return_value=telemetry):
            result = main.create_app()
        self.assertEqual(result, (host, telemetry, credential))
        self.assertIsNone(host_class.call_args.kwargs["configure_observability"])
        self.assertIsNone(host_class.call_args.kwargs["access_log"])
        self.assertEqual(host_class.call_args.kwargs["store"], "memory-only")
        host.run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
