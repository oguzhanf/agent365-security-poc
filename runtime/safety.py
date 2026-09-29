"""Fail-closed configuration and bounded HTTPS transport."""

import json
import http.client
import os
import re
import ssl
import urllib.error
import urllib.parse
import urllib.request
from uuid import UUID


class PocError(RuntimeError):
    """Only fixed, credential-free messages may cross the CLI boundary."""


def guid(value):
    if not isinstance(value, str) or not re.fullmatch(
        r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", value
    ):
        raise PocError("A canonical, nonzero GUID is required.")
    result = UUID(value)
    if result.int == 0:
        raise PocError("A canonical, nonzero GUID is required.")
    return str(result)


def required_env(name):
    value = os.environ.get(name, "")
    if not value or not value.strip():
        raise PocError("A required runtime environment variable is missing.")
    return value


def bounded_text(value, limit):
    if not isinstance(value, str):
        return False
    try:
        return len(value.encode("utf-8")) <= limit
    except UnicodeError:
        return False


def isolate_environment():
    prohibited_prefixes = (
        "OTEL_EXPORTER_", "OTEL_RESOURCE_", "OTEL_PYTHON_",
        "APPLICATIONINSIGHTS_CONNECTION", "APPINSIGHTS_INSTRUMENTATION",
        "SPECTRA_", "AZURE_MONITOR_", "OTEL_TRACES_SAMPLER",
    )
    prohibited_names = {
        "A365_OBSERVABILITY_DOMAIN_OVERRIDE", "A365_OBSERVABILITY_SCOPE_OVERRIDE",
        "A365_CLUSTER_CATEGORY", "OTEL_TRACES_EXPORTER", "OTEL_METRICS_EXPORTER",
        "OTEL_LOGS_EXPORTER", "OTEL_SERVICE_NAME", "AZURE_AUTHORITY_HOST",
    }
    if any(value and (key in prohibited_names or key.startswith(prohibited_prefixes))
           for key, value in os.environ.items()):
        raise PocError("Use a clean process without inherited exporter, authority, or instrumentation settings.")
    os.environ["MICROSOFT_OTEL_SDKSTATS_DISABLED"] = "true"
    os.environ["APPLICATIONINSIGHTS_STATSBEAT_DISABLED_ALL"] = "true"
    os.environ["ENABLE_A365_OBSERVABILITY_EXPORTER"] = "false"
    os.environ["ENABLE_OBSERVABILITY"] = "true"
    os.environ["ENABLE_A365_OBSERVABILITY"] = "true"
    os.environ["A365_SUPPRESS_INVOKE_AGENT_INPUT"] = "true"
    os.environ["ENABLE_SENSITIVE_DATA"] = "false"
    os.environ["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"] = "false"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if fp is not None:
            fp.close()
        raise PocError("HTTPS redirects are prohibited.")


class Https:
    """No proxy inheritance, redirects, retries, response-body logging, or disk cache."""

    def __init__(self, opener=None, timeout=20):
        if (isinstance(timeout, bool) or not isinstance(timeout, (int, float))
                or not 1 <= timeout <= 30):
            raise PocError("HTTPS timeout must be between 1 and 30 seconds.")
        self.timeout = timeout
        self.opener = opener or urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPSHandler(context=ssl.create_default_context()),
            NoRedirect(),
        )

    def post(self, url, data, headers, limit=262144):
        try:
            parsed = urllib.parse.urlsplit(url)
            valid = (
                isinstance(url, str) and not any(char.isspace() for char in url)
                and parsed.scheme == "https"
                and (parsed.hostname in ("login.microsoftonline.com", "agent365.svc.cloud.microsoft")
                     or re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.openai\.azure\.com",
                                     parsed.hostname or ""))
                and not parsed.username and not parsed.password and not parsed.fragment
                and parsed.port in (None, 443)
            )
        except (ValueError, TypeError, AttributeError):
            valid = False
        if not valid:
            raise PocError("Invalid HTTPS destination.")
        if (not isinstance(data, bytes) or len(data) > 524288
                or isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 1048576):
            raise PocError("HTTPS payload limit exceeded.")
        try:
            request = urllib.request.Request(url, data=data, headers=headers, method="POST")
            with self.opener.open(request, timeout=self.timeout) as response:
                if response.geturl() != url or not 200 <= response.status < 300:
                    raise PocError("HTTPS response was not successful; body withheld.")
                body = response.read(limit + 1)
                if len(body) > limit:
                    raise PocError("HTTPS response limit exceeded.")
                return body
        except urllib.error.HTTPError as error:
            status = error.code
            error.close()
            raise PocError(f"HTTPS request rejected (HTTP {status}); body withheld.") from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, http.client.HTTPException):
            raise PocError("HTTPS transport failed; details withheld.") from None

    def post_json(self, url, data, headers, limit=262144):
        body = self.post(url, data, headers, limit)
        try:
            value = json.loads(body)
        except (ValueError, UnicodeError, RecursionError):
            raise PocError("Invalid JSON response; body withheld.") from None
        if not isinstance(value, dict):
            raise PocError("Expected a JSON response object; body withheld.")
        return value
