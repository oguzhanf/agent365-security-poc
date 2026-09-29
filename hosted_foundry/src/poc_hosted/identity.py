"""Use only platform credentials. Never accept an HTTP-supplied bearer token."""

import base64
import json
import math
import time
from threading import Lock

from .settings import (
    ConfigurationError, OBSERVABILITY_APP_ID, OBSERVABILITY_ROLE, OBSERVABILITY_SCOPE, guid,
)


def platform_credential(factory=None):
    if factory is None:
        from azure.identity import DefaultAzureCredential
        factory = DefaultAzureCredential
    return factory(
        exclude_environment_credential=True,
        exclude_cli_credential=True,
        exclude_powershell_credential=True,
        exclude_developer_cli_credential=True,
        exclude_shared_token_cache_credential=True,
        exclude_visual_studio_code_credential=True,
        exclude_interactive_browser_credential=True,
        exclude_broker_credential=True,
        exclude_workload_identity_credential=False,
        exclude_managed_identity_credential=False,
    )


def inspect_sdk_token(access_token, tenant_id, agent_id, now=None):
    """Detect configuration mismatch in a trusted credential result, NOT JWT verification."""
    now = time.time() if now is None else now
    try:
        token = access_token.token
        if not isinstance(token, str) or len(token) > 32768:
            raise ValueError()
        parts = token.split(".")
        if len(parts) != 3:
            raise ValueError()
        claims = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
        if not isinstance(claims, dict):
            raise ValueError()
        if claims.get("aud") not in (OBSERVABILITY_APP_ID, f"api://{OBSERVABILITY_APP_ID}"):
            raise ValueError()
        if guid(claims.get("tid"), "token tenant") != tenant_id:
            raise ValueError()
        clients = [claims[key] for key in ("appid", "azp") if key in claims]
        if not clients or any(guid(value, "token application") != agent_id for value in clients):
            raise ValueError()
        if claims.get("scp") or claims.get("idtyp") not in (None, "app"):
            raise ValueError()
        roles = claims.get("roles")
        if not isinstance(roles, list) or OBSERVABILITY_ROLE not in roles:
            raise ValueError()
        expiry, sdk_expiry = float(claims["exp"]), float(access_token.expires_on)
        if not all(math.isfinite(value) and value > now + 60 for value in (expiry, sdk_expiry)):
            raise ValueError()
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
        raise ConfigurationError("Platform observability token identity, audience, role, or expiry mismatch.") from None
    return token


class ObservabilityTokenResolver:
    def __init__(self, credential, settings):
        self.credential = credential
        self.settings = settings
        self.lock = Lock()

    def __call__(self, agent_id, tenant_id):
        if agent_id != self.settings.agent_id or tenant_id != self.settings.tenant_id:
            raise ConfigurationError("Exporter identity does not match approved configuration.")
        with self.lock:
            try:
                token = self.credential.get_token(OBSERVABILITY_SCOPE)
            except Exception:
                raise ConfigurationError(
                    "Platform credential unavailable. Do not enable developer fallback. "
                    "Confirm the supported hosted identity path with the platform operator."
                ) from None
            return inspect_sdk_token(token, tenant_id, agent_id)
