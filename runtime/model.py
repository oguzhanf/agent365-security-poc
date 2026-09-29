"""Azure OpenAI chat completions REST; a separate tenant-scoped model identity."""

import json
import math
import re
import time
from urllib.parse import urlsplit

from .safety import Https, PocError, guid
from .auth import token_claims

MODEL_SCOPE = "https://ai.azure.com/.default"
LEGACY_MODEL_SCOPE = "https://cognitiveservices.azure.com/.default"


def model_url(endpoint, deployment, api_version):
    try:
        parsed = urlsplit(endpoint)
        valid = (
            isinstance(endpoint, str) and not any(char.isspace() for char in endpoint)
            and parsed.scheme == "https"
            and re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.openai\.azure\.com",
                             parsed.hostname or "")
            and parsed.port in (None, 443)
            and not parsed.username and not parsed.password
            and parsed.path in ("", "/") and not parsed.query and not parsed.fragment
            and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", deployment)
            and (api_version == "v1" or re.fullmatch(r"\d{4}-\d{2}-\d{2}", api_version))
        )
    except (ValueError, TypeError):
        valid = False
    if not valid:
        raise PocError("Invalid Azure OpenAI endpoint, deployment, or API version.")
    if api_version == "v1":
        return f"https://{parsed.hostname}/openai/v1/chat/completions"
    return (f"https://{parsed.hostname}/openai/deployments/{deployment}"
            f"/chat/completions?api-version={api_version}")


class AzureOpenAI:
    def __init__(self, endpoint, deployment, tenant_id, api_version="v1",
                 credential=None, http=None):
        self.url = model_url(endpoint, deployment, api_version)
        self.deployment = deployment
        self.scope = MODEL_SCOPE if api_version == "v1" else LEGACY_MODEL_SCOPE
        self.tenant_id = guid(tenant_id)
        self.http = http or Https()
        self._credential = credential

    def _token(self):
        if self._credential is None:
            try:
                from azure.identity import AzureCliCredential
            except ImportError:
                raise PocError("Install requirements-runtime.lock.txt in the isolated venv.") from None
            self._credential = AzureCliCredential(tenant_id=self.tenant_id, process_timeout=20)
        try:
            from azure.core.exceptions import ClientAuthenticationError
        except ImportError:
            # Injected credentials used by stdlib-only unit tests need no Azure package.
            ClientAuthenticationError = type("UnavailableAzureAuthenticationError", (Exception,), {})
        try:
            token = self._credential.get_token(self.scope, tenant_id=self.tenant_id)
        except (ClientAuthenticationError, OSError, ValueError):
            raise PocError("Model authentication failed; credential details withheld.") from None
        value = getattr(token, "token", None)
        expiry = getattr(token, "expires_on", None)
        if (not isinstance(expiry, (int, float)) or isinstance(expiry, bool)
                or not time.time() < expiry <= time.time() + 86400 or not math.isfinite(expiry)):
            raise PocError("Model credential returned an invalid or expired token.")
        audience = self.scope.removesuffix("/.default")
        token_claims(value, self.tenant_id, (audience, audience + "/"), time.time())
        return value

    def complete(self, messages, tools):
        data = json.dumps({
            "model": self.deployment, "messages": messages, "tools": tools, "tool_choice": "auto",
            "max_completion_tokens": 800, "stream": False,
        }, ensure_ascii=True).encode("utf-8")
        if len(data) > 65536:
            raise PocError("Model input limit exceeded.")
        token = self._token()
        result = self.http.post_json(
            self.url, data,
            {"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        )
        try:
            choices = result["choices"]
            if not isinstance(choices, list) or len(choices) != 1:
                raise ValueError
            choice = choices[0]
            if choice.get("finish_reason") not in ("stop", "tool_calls"):
                raise ValueError
            message = choice["message"]
            if not isinstance(message, dict) or message.get("role") != "assistant":
                raise ValueError
            calls = message.get("tool_calls")
            if (choice["finish_reason"] == "tool_calls") != bool(calls):
                raise ValueError
            usage = result.get("usage", {})
            if not isinstance(usage, dict):
                raise ValueError
            counts = {}
            for field in ("prompt_tokens", "completion_tokens"):
                count = usage.get(field)
                if count is not None:
                    if isinstance(count, bool) or not isinstance(count, int) or not 0 <= count <= 1000000:
                        raise ValueError
                    counts[field] = count
            return message, counts
        except (KeyError, ValueError, TypeError, AttributeError):
            raise PocError("Unsupported or incomplete model response; body withheld.") from None
