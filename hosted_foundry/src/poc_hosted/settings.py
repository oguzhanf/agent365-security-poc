"""Configuration for the isolated, synthetic hosted-agent sample."""

import re
from dataclasses import dataclass
from urllib.parse import urlsplit
from uuid import UUID

OBSERVABILITY_APP_ID = "9b975845-388f-4429-889e-eab1ef63949c"
OBSERVABILITY_SCOPE = f"api://{OBSERVABILITY_APP_ID}/.default"
OBSERVABILITY_ROLE_ID = "8f71190c-00c8-461d-a63b-f74abde9ba52"
OBSERVABILITY_ROLE = "Agent365.Observability.OtelWrite"


class ConfigurationError(RuntimeError):
    pass


def identifier(value, label):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", value):
        raise ConfigurationError(f"Invalid {label}.")
    return value


def guid(value, label):
    try:
        result = str(UUID(value))
        if result == "00000000-0000-0000-0000-000000000000":
            raise ValueError()
        return result
    except (ValueError, TypeError, AttributeError):
        raise ConfigurationError(f"{label} must be a nonzero GUID.") from None


@dataclass(frozen=True)
class Settings:
    endpoint: str
    model: str
    agent_name: str
    agent_version: str
    export: bool = False
    tenant_id: str = ""
    agent_id: str = ""
    max_concurrency: int = 2
    timeout_seconds: int = 45

    @classmethod
    def from_env(cls, env):
        enabled = env.get("POC_A365_EXPORT", "false").strip().lower()
        if enabled not in ("true", "false"):
            raise ConfigurationError("POC_A365_EXPORT must be true or false.")
        endpoint = env.get("FOUNDRY_PROJECT_ENDPOINT", "")
        url = urlsplit(endpoint)
        if (
            url.scheme != "https"
            or not url.hostname
            or not url.hostname.endswith(".services.ai.azure.com")
            or url.username or url.password or url.port not in (None, 443)
            or url.query or url.fragment
            or not re.fullmatch(r"/api/projects/[A-Za-z0-9_.-]+/?", url.path)
        ):
            raise ConfigurationError("A public-cloud Foundry project endpoint is required.")
        tenant = env.get("A365_TENANT_ID", "")
        agent = env.get("A365_AGENT_ID", "")
        if enabled == "true" or tenant:
            tenant = guid(tenant, "A365_TENANT_ID")
        if enabled == "true" or agent:
            agent = guid(agent, "A365_AGENT_ID (application/client ID, not object ID)")
        return cls(
            endpoint=endpoint.rstrip("/"),
            model=identifier(env.get("AZURE_AI_MODEL_DEPLOYMENT_NAME"), "approved model deployment"),
            agent_name=identifier(env.get("FOUNDRY_AGENT_NAME"), "platform agent name"),
            agent_version=identifier(env.get("FOUNDRY_AGENT_VERSION"), "platform agent version"),
            export=enabled == "true",
            tenant_id=tenant,
            agent_id=agent,
        )


def prepare_environment(env, export):
    # Do not let a preconfigured collector or endpoint override redirect this lab.
    forbidden = (
        "OTEL_EXPORTER_", "OTEL_PYTHON_", "OTEL_TRACES_", "OTEL_METRICS_",
        "OTEL_LOGS_", "OTEL_RESOURCE_ATTRIBUTES", "OTEL_SERVICE_NAME",
        "A365_OBSERVABILITY_DOMAIN_OVERRIDE", "A365_OBSERVABILITY_SCOPE_OVERRIDE",
        "SPECTRA_ENDPOINT", "AZURE_TOKEN_CREDENTIALS",
    )
    if any(value and key.startswith(forbidden) for key, value in env.items()):
        raise ConfigurationError("Remove inherited telemetry/credential overrides; use a clean process.")
    env.update({
        "MICROSOFT_OTEL_SDKSTATS_DISABLED": "true",
        "APPLICATIONINSIGHTS_STATSBEAT_DISABLED_ALL": "true",
        "AZURE_TRACING_GEN_AI_CONTENT_RECORDING_ENABLED": "false",
        "ENABLE_INSTRUMENTATION": "false",
        "ENABLE_SENSITIVE_DATA": "false",
        "ENABLE_OBSERVABILITY": "true",
        "ENABLE_A365_OBSERVABILITY": "true",
        "ENABLE_A365_OBSERVABILITY_EXPORTER": str(export).lower(),
    })
