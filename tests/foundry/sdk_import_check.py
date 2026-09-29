"""Import-only compatibility check after installing hosted_foundry/src/requirements.txt.

Run in a dedicated process. The Python socket/DNS audit guard stays installed
until process exit; it is not an operating-system network firewall.
"""

import importlib.util
import inspect
import os
from pathlib import Path
import sys


class NetworkAccessBlocked(OSError):
    pass


def install_network_guard():
    def deny_socket_operations(event, _args):
        if event.startswith("socket."):
            raise NetworkAccessBlocked(f"Import smoke check blocked {event}.")

    # Audit events cover socket construction, connections and DNS, including
    # callers using the low-level _socket module instead of socket.
    sys.addaudithook(deny_socket_operations)


def check_sdk_imports():
    source = Path(__file__).resolve().parents[2] / "hosted_foundry" / "src"
    sys.path.insert(0, str(source))
    spec = importlib.util.spec_from_file_location("hosted_import_smoke_main", source / "main.py")
    if spec is None or spec.loader is None:
        raise RuntimeError("Hosted entry point could not be loaded.")
    entry_point = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(entry_point)

    from agent_framework import Agent
    from agent_framework.foundry import FoundryChatClient
    from agent_framework.observability import disable_instrumentation
    from azure.ai.agentserver.core.platform_headers import FOUNDRY_CALL_ID
    from azure.ai.agentserver.responses import (
        CreateResponse, InMemoryResponseProvider, ResponseContext,
        ResponsesAgentServerHost, ResponsesServerOptions, TextResponse,
    )
    from azure.identity import DefaultAzureCredential
    from microsoft.opentelemetry.a365.core import (
        AgentDetails, ExecuteToolScope, InvokeAgentScope, InvokeAgentScopeDetails,
        Request, ToolCallDetails,
    )
    from microsoft.opentelemetry.a365.core.exporters.agent365_exporter import _Agent365Exporter
    from opentelemetry import context, metrics, trace
    from opentelemetry._logs import NoOpLoggerProvider, set_logger_provider
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor
    from opentelemetry.sdk.trace.sampling import ALWAYS_ON

    symbols = (
        entry_point.create_app, entry_point.main, Agent, FoundryChatClient,
        disable_instrumentation, CreateResponse, InMemoryResponseProvider,
        ResponseContext, ResponsesAgentServerHost, ResponsesServerOptions,
        TextResponse, DefaultAzureCredential, AgentDetails, ExecuteToolScope.start,
        InvokeAgentScope.start, InvokeAgentScopeDetails, Request, ToolCallDetails,
        _Agent365Exporter, context.Context, metrics.NoOpMeterProvider,
        trace.NoOpTracer, trace.ProxyTracerProvider, NoOpLoggerProvider,
        set_logger_provider, Resource, TracerProvider, BatchSpanProcessor,
    )
    if not all(callable(symbol) for symbol in symbols):
        raise RuntimeError("A required hosted SDK symbol is not callable.")
    if FOUNDRY_CALL_ID != "x-agent-foundry-call-id" or ALWAYS_ON is None:
        raise RuntimeError("A required hosted SDK constant changed.")
    exporter_parameters = inspect.signature(_Agent365Exporter).parameters
    required = {"token_resolver", "use_s2s_endpoint", "cluster_category", "enable_durable_delivery"}
    if not required.issubset(exporter_parameters):
        raise RuntimeError("The pinned internal exporter contract changed.")


def main():
    install_network_guard()
    os.environ.update({
        "MICROSOFT_OTEL_SDKSTATS_DISABLED": "true",
        "APPLICATIONINSIGHTS_STATSBEAT_DISABLED_ALL": "true",
        "ENABLE_INSTRUMENTATION": "false",
        "ENABLE_SENSITIVE_DATA": "false",
        "ENABLE_OBSERVABILITY": "false",
        "ENABLE_A365_OBSERVABILITY": "false",
        "ENABLE_A365_OBSERVABILITY_EXPORTER": "false",
        "FOUNDRY_AGENT365_TRACING_ENABLED": "false",
        "AZURE_TRACING_GEN_AI_CONTENT_RECORDING_ENABLED": "false",
        "OTEL_SDK_DISABLED": "true",
        "OTEL_TRACES_EXPORTER": "none",
        "OTEL_METRICS_EXPORTER": "none",
        "OTEL_LOGS_EXPORTER": "none",
    })
    check_sdk_imports()
    print("Hosted SDK imports passed; Python socket/DNS operations remained blocked.")
    print("No provider, credential, exporter, app, server or model client was constructed.")


if __name__ == "__main__":
    main()
