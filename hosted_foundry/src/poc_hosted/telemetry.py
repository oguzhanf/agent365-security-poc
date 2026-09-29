"""Explicit metadata-only SDK scopes and an opt-in, isolated export pipeline."""

import asyncio
from contextlib import contextmanager
from contextvars import ContextVar

from .identity import ObservabilityTokenResolver
from .settings import ConfigurationError

_request = ContextVar("hosted_a365_request", default=None)


class OperationFailed(RuntimeError):
    pass


@contextmanager
def safe_scope(scope):
    failure = None
    with scope:
        try:
            yield scope
        except asyncio.CancelledError:
            scope.record_cancellation()
            failure = asyncio.CancelledError()
        except Exception:
            # SDK scope __exit__ records exceptions, including their messages.
            # Do not give it a model/HTTP exception or its original traceback.
            scope.record_error(OperationFailed("Synthetic operation failed."))
            failure = OperationFailed("Synthetic operation failed.")
    if failure is not None:
        raise failure from None


class Telemetry:
    def __init__(self, settings, provider, core, trace, context):
        self.settings = settings
        self.provider = provider
        self.core = core
        self.trace = trace
        self.context = context
        self.agent = core.AgentDetails(
            agent_id=settings.agent_id,
            tenant_id=settings.tenant_id or None,
            agent_name=settings.agent_name,
            agent_version=settings.agent_version,
        )

    @contextmanager
    def invocation(self, conversation_id, session_id):
        request = self.core.Request(conversation_id=conversation_id, session_id=session_id)
        token = _request.set(request)
        # This root intentionally excludes untrusted incoming baggage and caller attributes.
        clean = self.context.attach(self.context.Context())
        try:
            scope = self.core.InvokeAgentScope.start(
                request, self.core.InvokeAgentScopeDetails(), self.agent,
            )
            with safe_scope(scope):
                span_context = self.trace.get_current_span().get_span_context()
                if not span_context.is_valid:
                    raise OperationFailed("Recording provider unavailable.")
                yield f"{span_context.trace_id:032x}"
        finally:
            self.context.detach(clean)
            _request.reset(token)

    @contextmanager
    def tool(self):
        request = _request.get()
        if request is None:
            raise OperationFailed("Tool requires an active invocation.")
        scope = self.core.ExecuteToolScope.start(
            request, self.core.ToolCallDetails(tool_name="synthetic_add"), self.agent,
        )
        with safe_scope(scope):
            yield

    def close(self):
        try:
            return self.provider.force_flush(timeout_millis=5000)
        finally:
            self.provider.shutdown()


def configure(settings, credential):
    from opentelemetry import context, metrics, trace
    from opentelemetry._logs import NoOpLoggerProvider, set_logger_provider
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.sampling import ALWAYS_ON
    from microsoft.opentelemetry.a365 import core

    if not isinstance(trace.get_tracer_provider(), trace.ProxyTracerProvider):
        raise ConfigurationError("A telemetry provider already exists. Start a clean, non-auto-instrumented process.")

    class ScopeOnlyProvider(TracerProvider):
        def get_tracer(self, instrumenting_module_name, *args, **kwargs):
            if instrumenting_module_name != "Agent365Sdk":
                return trace.NoOpTracer()
            return super().get_tracer(instrumenting_module_name, *args, **kwargs)

    provider = ScopeOnlyProvider(
        resource=Resource({"service.name": "a365-hosted-synthetic"}),
        sampler=ALWAYS_ON,
    )
    try:
        if settings.export:
            resolver = ObservabilityTokenResolver(credential, settings)
            resolver(settings.agent_id, settings.tenant_id)
            # Pinned internal adapter: 1.3.9 has no public direct-exporter factory.
            # Avoid distro auto-exporters, instrumentation, resource detectors and SDKStats.
            from microsoft.opentelemetry.a365.core.exporters.agent365_exporter import _Agent365Exporter
            from opentelemetry.sdk.trace.export import BatchSpanProcessor
            exporter = _Agent365Exporter(
                token_resolver=resolver,
                use_s2s_endpoint=True,
                cluster_category="prod",
                enable_durable_delivery=False,
            )
            provider.add_span_processor(BatchSpanProcessor(
                exporter, max_queue_size=64, max_export_batch_size=8,
                schedule_delay_millis=1000, export_timeout_millis=5000,
            ))
        trace.set_tracer_provider(provider)
        metrics.set_meter_provider(metrics.NoOpMeterProvider())
        set_logger_provider(NoOpLoggerProvider())
        return Telemetry(settings, provider, core, trace, context)
    except BaseException:
        provider.shutdown()
        raise
