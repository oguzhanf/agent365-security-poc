"""Current A365 manual scopes with an explicit metadata-only export boundary."""

from contextlib import contextmanager
import logging
from uuid import uuid4

from .safety import PocError, isolate_environment

METADATA_KEYS = frozenset({
    "gen_ai.operation.name", "gen_ai.agent.id", "gen_ai.agent.name",
    "microsoft.a365.agent.blueprint.id", "microsoft.tenant.id",
    "gen_ai.conversation.id", "microsoft.session.id", "gen_ai.provider.name",
    "gen_ai.request.model", "gen_ai.tool.name", "gen_ai.tool.type",
    "gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens",
    "telemetry.sdk.name", "telemetry.sdk.language", "telemetry.sdk.version",
    "poc.tool.allowed", "poc.synthetic",
})


def metadata_span(span, resource):
    from opentelemetry.sdk.trace import ReadableSpan
    from opentelemetry.sdk.util.instrumentation import InstrumentationScope
    from opentelemetry.trace import Status
    operation = (span.attributes or {}).get("gen_ai.operation.name")
    if operation == "Chat":
        operation = "chat"
    if operation not in ("invoke_agent", "execute_tool", "chat"):
        raise PocError("Unexpected telemetry operation.")
    return ReadableSpan(
        name=operation, context=span.context, parent=span.parent,
        resource=resource, attributes={
            **{
                key: value for key, value in (span.attributes or {}).items()
                if key in METADATA_KEYS
            },
            "gen_ai.operation.name": operation,
        },
        events=(), links=(), kind=span.kind,
        status=Status(span.status.status_code),
        start_time=span.start_time, end_time=span.end_time,
        instrumentation_scope=InstrumentationScope("agent365-security-poc", "1.0.0"),
    )


def checked_exporter(delegate, resource):
    from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult

    class MetadataExporter(SpanExporter):
        failed = False
        count = 0

        def export(self, spans):
            try:
                clean = [metadata_span(span, resource) for span in spans]
                result = delegate.export(clean)
            except (PocError, OSError, ValueError, TypeError):
                self.failed = True
                return SpanExportResult.FAILURE
            self.count += len(clean)
            if result != SpanExportResult.SUCCESS:
                self.failed = True
            return result

        def force_flush(self, timeout_millis=30000):
            return delegate.force_flush(timeout_millis)

        def shutdown(self):
            delegate.shutdown()

    return MetadataExporter()


class Telemetry:
    def __init__(self, deployment="synthetic-no-model", resolver=None, output=None):
        isolate_environment()
        try:
            from opentelemetry import trace
            from opentelemetry.sdk.resources import Resource
            from opentelemetry.sdk.trace import TracerProvider
            from opentelemetry.sdk.trace.sampling import ALWAYS_ON
            from opentelemetry.sdk.trace.export import ConsoleSpanExporter, SimpleSpanProcessor
            from microsoft.opentelemetry.a365 import core
        except ImportError:
            raise PocError("Install requirements-runtime.lock.txt in the isolated venv.") from None
        # Suppress SDK response/body diagnostics. The CLI reports fixed errors.
        logging.getLogger("microsoft.opentelemetry").setLevel(logging.CRITICAL + 1)
        logging.getLogger("azure").setLevel(logging.CRITICAL + 1)
        self.trace = trace
        self.core = core
        self.deployment = deployment
        self.conversation_id = str(uuid4())
        self.trace_id = None
        self.resolver = resolver
        self.session = None
        self._stack = []
        resource = Resource({"service.name": "agent365-security-poc", "poc.synthetic": True})
        self.provider = TracerProvider(resource=resource, sampler=ALWAYS_ON, shutdown_on_exit=False)
        if resolver:
            from .sdk_export import make_sdk_exporter
            delegate, self.session = make_sdk_exporter(resolver)
        else:
            delegate = ConsoleSpanExporter(out=output) if output else ConsoleSpanExporter()
        self.exporter = checked_exporter(delegate, resource)
        self.provider.add_span_processor(SimpleSpanProcessor(self.exporter))
        trace.set_tracer_provider(self.provider)
        if trace.get_tracer_provider() is not self.provider:
            self.provider.shutdown()
            raise PocError("Telemetry is already initialized. Start a fresh process for each mode.")
        self.agent = core.AgentDetails(
            agent_id=resolver.agent_id if resolver else "local-synthetic-agent",
            tenant_id=resolver.tenant_id if resolver else "local-synthetic-tenant",
            agent_blueprint_id=resolver.blueprint_id if resolver else None,
            agent_name="Synthetic equipment procedure agent",
        )
        self.request = core.Request(
            conversation_id=self.conversation_id, session_id=self.conversation_id
        )

    @contextmanager
    def scope(self, kind, name=None):
        if kind == "invoke":
            scope = self.core.InvokeAgentScope.start(
                self.request, self.core.InvokeAgentScopeDetails(), self.agent
            )
        elif kind == "tool":
            if name not in ("read_fixture", "unapproved_tool"):
                raise PocError("Unknown telemetry tool name.")
            scope = self.core.ExecuteToolScope.start(
                self.request, self.core.ToolCallDetails(tool_name=name, tool_type="function"), self.agent
            )
        elif kind == "inference":
            scope = self.core.InferenceScope.start(
                self.request, self.core.InferenceCallDetails(
                    operationName=self.core.InferenceOperationType.CHAT,
                    model=self.deployment, providerName="azure.ai.openai",
                ), self.agent
            )
        else:
            raise PocError("Unknown telemetry scope.")
        with scope:
            current = self.trace.get_current_span()
            self.trace_id = f"{current.get_span_context().trace_id:032x}"
            current.set_attribute("poc.synthetic", True)
            self._stack.append(scope)
            try:
                yield
            finally:
                self._stack.pop()

    def usage(self, counts):
        for source, target in (
            ("prompt_tokens", "gen_ai.usage.input_tokens"),
            ("completion_tokens", "gen_ai.usage.output_tokens"),
        ):
            if source in counts:
                self.trace.get_current_span().set_attribute(target, counts[source])

    def decision(self, allowed):
        self.trace.get_current_span().set_attribute("poc.tool.allowed", bool(allowed))

    def finish(self):
        flushed = self.provider.force_flush(timeout_millis=30000)
        if not flushed or self.exporter.failed or (self.session and self.session.failed):
            raise PocError("Telemetry export failed; ingestion is unverified.")
        if not self.exporter.count or not self.trace_id or int(self.trace_id, 16) == 0:
            raise PocError("No valid telemetry spans were produced.")
        if self.session and self.session.sent == 0:
            raise PocError("No Agent365 HTTP export was observed; ingestion is unverified.")
        return {
            "trace_id": self.trace_id, "conversation_id": self.conversation_id,
            "telemetry": ("export_attempted_ingestion_unverified" if self.resolver
                          else "console_metadata_only"),
            "ingestion_verified": False,
        }

    def close(self):
        self.provider.shutdown()
