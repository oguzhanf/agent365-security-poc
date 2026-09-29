"""Pinned 1.3.9 transport seam: strict destination, no redirects, visible failures."""

import json
from types import SimpleNamespace

from .safety import Https, PocError, guid


class StrictAgent365Session:
    """The SDK serializer remains unchanged; only its requests Session is replaced."""

    def __init__(self, tenant, agent, http=None):
        self.url = (
            "https://agent365.svc.cloud.microsoft/observabilityService/tenants/"
            f"{guid(tenant)}/otlp/agents/{guid(agent)}/traces?api-version=1"
        )
        self.http = http or Https()
        self.sent = 0
        self.failed = False

    def post(self, url, data, headers, timeout):
        try:
            if url != self.url or not isinstance(data, bytes):
                raise PocError("Agent365 destination or payload rejected.")
            if (isinstance(timeout, bool) or not isinstance(timeout, (int, float))
                    or not 0 < timeout <= 30):
                raise PocError("Agent365 timeout rejected.")
            auth = headers.get("authorization")
            if (not isinstance(auth, str) or not auth.startswith("Bearer ")
                    or not 1 <= len(auth[7:]) <= 32768
                    or any(char.isspace() for char in auth[7:])):
                raise PocError("Agent365 authorization is missing.")
            body = self.http.post(url, data, {
                "Content-Type": "application/json", "Authorization": auth,
            }, limit=65536)
            # Any explicit partial/rejected/error response is failure. An empty
            # successful response still is NOT evidence of downstream ingestion.
            if body.strip():
                try:
                    result = json.loads(body)
                except (ValueError, UnicodeError, RecursionError):
                    raise PocError("Agent365 returned an unrecognized response; body withheld.") from None
                if not isinstance(result, dict):
                    raise PocError("Agent365 returned an unrecognized response; body withheld.")
                partial = result.get("partialSuccess", result.get("partial_success", {}))
                if (not isinstance(partial, dict) or partial.get("rejectedSpans", 0) not in (0, "0")
                        or partial.get("errorMessage") or partial.get("rejected_spans", 0) not in (0, "0")
                        or partial.get("error_message") or result.get("error") or result.get("rejectedSpans")):
                    raise PocError("Agent365 reported a partial or rejected export; body withheld.")
                if "results" in result:
                    results = result["results"]
                    if not isinstance(results, list) or not results:
                        raise PocError("Agent365 returned an unrecognized routing response; body withheld.")
                    for entry in results:
                        sinks = entry.get("sinks") if isinstance(entry, dict) else None
                        if not isinstance(sinks, dict) or not sinks:
                            raise PocError("Agent365 returned an unrecognized routing response; body withheld.")
                        statuses = [sink.get("status") if isinstance(sink, dict) else None
                                    for sink in sinks.values()]
                        if "sent" not in statuses or any(status not in ("sent", "not_routed") for status in statuses):
                            raise PocError("Agent365 reported rejected or unrouted spans; body withheld.")
            self.sent += 1
            return SimpleNamespace(status_code=200, headers={}, text="")
        except PocError:
            self.failed = True
            raise

    def close(self):
        pass


def make_sdk_exporter(resolver):
    from importlib.metadata import version
    if version("microsoft-opentelemetry") != "1.3.9":
        raise PocError("The strict Agent365 transport adapter requires SDK 1.3.9.")
    from microsoft.opentelemetry.a365.core.exporters.agent365_exporter import _Agent365Exporter
    exporter = _Agent365Exporter(
        token_resolver=resolver, cluster_category="prod",
        use_s2s_endpoint=True, enable_durable_delivery=False,
    )
    session = StrictAgent365Session(resolver.tenant_id, resolver.agent_id)
    exporter._session.close()
    exporter._session = session
    return exporter, session
