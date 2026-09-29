"""Explicit installed-SDK check. Blocks network and subprocesses before SDK imports."""

from contextlib import ExitStack
import io
import json
import os
from pathlib import Path
import socket
import sys
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


def check():
    with ExitStack() as stack:
        blockers = []
        for target in ("socket.socket.connect", "socket.socket.connect_ex", "socket.socket.sendto",
                       "socket.create_connection", "socket.getaddrinfo", "subprocess.Popen"):
            blockers.append(stack.enter_context(patch(
                target, side_effect=AssertionError("Offline SDK test prohibited I/O.")
            )))
        from importlib.metadata import version
        from runtime.safety import PocError
        from runtime.telemetry import Telemetry
        from runtime.agent import run_agent, run_smoke
        from runtime import telemetry

        clean_spans = []
        original_metadata_span = telemetry.metadata_span

        def collect(span, resource):
            clean = original_metadata_span(span, resource)
            clean_spans.append(clean)
            return clean

        stack.enter_context(patch.object(telemetry, "metadata_span", side_effect=collect))

        assert version("microsoft-opentelemetry") == "1.3.9"
        output = io.StringIO()
        monitor = Telemetry(output=output)
        try:
            tenant = "11111111-1111-4111-8111-111111111111"
            blueprint = "22222222-2222-4222-8222-222222222222"
            agent_id = "33333333-3333-4333-8333-333333333333"
            monitor.agent = monitor.core.AgentDetails(
                agent_id=agent_id, tenant_id=tenant, agent_blueprint_id=blueprint, agent_name="Synthetic test"
            )
            assert run_smoke(monitor)["restricted_fixture_denied"]
            responses = iter([
                ({"role": "assistant", "content": None, "tool_calls": [{
                    "id": "safe_call", "type": "function",
                    "function": {"name": "read_fixture", "arguments": '{"name":"public-procedure.txt"}'},
                }]}, {"prompt_tokens": 10, "completion_tokens": 5}),
                ({"role": "assistant", "content": "POC-APPROVAL-6142"}, {"prompt_tokens": 20, "completion_tokens": 8}),
            ])
            result = run_agent(SimpleNamespace(complete=lambda *_: next(responses)), "approval", telemetry=monitor)
            assert result["model_rounds"] == 2
            try:
                with monitor.scope("invoke"):
                    current = monitor.trace.get_current_span()
                    current.set_attribute("gen_ai.input.messages", "DO_NOT_EXPORT_CONTENT")
                    current.set_attribute("gen_ai.output.messages", "DO_NOT_EXPORT_CONTENT")
                    current.set_attribute("gen_ai.tool.arguments", "DO_NOT_EXPORT_CONTENT")
                    current.set_attribute("gen_ai.tool.result", "DO_NOT_EXPORT_CONTENT")
                    current.add_event("DO_NOT_EXPORT_CONTENT")
                    raise PocError("DO_NOT_EXPORT_CONTENT")
            except PocError:
                pass
            report = monitor.finish()
            assert report["ingestion_verified"] is False
            assert report["telemetry"] == "console_metadata_only"
            text = output.getvalue()
            assert "DO_NOT_EXPORT_CONTENT" not in text
            assert "POC-APPROVAL-6142" not in text
            assert "POC-RESTRICTED-4826" not in text
            decoder = json.JSONDecoder()
            spans = []
            while text.strip():
                span, end = decoder.raw_decode(text.lstrip())
                spans.append(span)
                text = text.lstrip()[end:]
            assert len(spans) == 8, len(spans)
            assert {span["name"] for span in spans} == {"invoke_agent", "execute_tool", "chat"}
            roots = {span["context"]["trace_id"]: span["context"]["span_id"]
                     for span in spans if span["name"] == "invoke_agent"}
            for span in spans:
                attrs = span["attributes"]
                assert attrs["microsoft.tenant.id"] == tenant
                assert attrs["microsoft.a365.agent.blueprint.id"] == blueprint
                assert attrs["gen_ai.agent.id"] == agent_id
                assert attrs["gen_ai.conversation.id"] == monitor.conversation_id
                assert not span["events"] and not span["links"]
                if span["name"] != "invoke_agent":
                    assert span["parent_id"] == roots[span["context"]["trace_id"]]
            assert any(span["attributes"].get("gen_ai.usage.input_tokens") == 10 for span in spans)
            assert any(span["attributes"].get("poc.tool.allowed") is False for span in spans)
            for variable in ("MICROSOFT_OTEL_SDKSTATS_DISABLED", "APPLICATIONINSIGHTS_STATSBEAT_DISABLED_ALL"):
                assert os.environ[variable] == "true"

            # Construct the pinned adapter, but never call export or resolve a token.
            from runtime.sdk_export import make_sdk_exporter, StrictAgent365Session
            resolver = SimpleNamespace(tenant_id=tenant, blueprint_id=blueprint, agent_id=agent_id)
            exporter, session = make_sdk_exporter(resolver)
            try:
                assert isinstance(session, StrictAgent365Session)
                assert exporter._enable_durable_delivery is False
                assert exporter._storage is None and exporter._replay is None
                assert exporter.record_sdkstats is False
                assert exporter._build_export_url(tenant, agent_id, True) == session.url
                assert session.sent == 0
                from microsoft.opentelemetry.a365.core.exporters.utils import filter_and_partition_by_identity
                groups = filter_and_partition_by_identity(clean_spans)
                assert set(groups) == {(tenant, agent_id)}
                assert len(groups[(tenant, agent_id)]) == 8
                mapped = exporter._map_and_truncate_spans(clean_spans)
                body = exporter._serialize_chunk(
                    mapped, exporter._get_resource_attributes(clean_spans), 0, 1, tenant, agent_id
                )
                assert json.loads(body)["resourceSpans"]
                assert "DO_NOT_EXPORT_CONTENT" not in body
                assert "gen_ai.input.messages" not in body
                assert "gen_ai.tool.arguments" not in body
            finally:
                exporter.shutdown()
        finally:
            monitor.close()
        for blocker in blockers:
            blocker.assert_not_called()
        print(json.dumps({"sdk": "1.3.9", "offline_spans_checked": 8, "network_blocked": True,
                          "export_called": False, "ingestion_verified": False}))


if __name__ == "__main__":
    check()
