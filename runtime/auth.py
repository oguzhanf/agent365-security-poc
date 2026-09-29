"""Development-only blueprint FMI exchange; never used as the model credential."""

import base64
import binascii
import json
import math
import threading
import time
import urllib.parse

from .safety import Https, PocError, guid

OBSERVABILITY_APP = "9b975845-388f-4429-889e-eab1ef63949c"
OBSERVABILITY_SCOPE = f"api://{OBSERVABILITY_APP}/.default"
OBSERVABILITY_ROLE = "Agent365.Observability.OtelWrite"


def lifetime(value):
    if isinstance(value, bool):
        raise PocError("Token expiry is invalid.")
    try:
        seconds = float(value)
    except (TypeError, ValueError, OverflowError):
        raise PocError("Token expiry is invalid.") from None
    if not math.isfinite(seconds) or not 0 < seconds <= 86400:
        raise PocError("Token expiry is invalid.")
    return seconds


def token_claims(token, tenant, audiences, now):
    """TLS-response consistency check, NOT JWT signature validation or authorization."""
    try:
        if (not isinstance(token, str) or not 1 <= len(token) <= 32768
                or any(char.isspace() for char in token)):
            raise ValueError
        parts = token.split(".")
        if len(parts) != 3 or not all(parts):
            raise ValueError
        payload = parts[1] + "=" * (-len(parts[1]) % 4)
        claims = json.loads(base64.b64decode(payload, altchars=b"-_", validate=True))
        if not isinstance(claims, dict):
            raise ValueError
        if (claims.get("aud") not in audiences or guid(claims.get("tid")) != tenant
                or claims.get("iss") not in (
                    f"https://sts.windows.net/{tenant}/",
                    f"https://login.microsoftonline.com/{tenant}/v2.0",
                )):
            raise ValueError
        expires = claims.get("exp")
        not_before = claims.get("nbf", now)
        if (isinstance(expires, bool) or not isinstance(expires, (int, float))
                or isinstance(not_before, bool) or not isinstance(not_before, (int, float))
                or not math.isfinite(not_before) or not_before > now):
            raise ValueError
        return claims, lifetime(expires - now)
    except (ValueError, TypeError, UnicodeError, binascii.Error, PocError, RecursionError, OverflowError):
        raise PocError("Token audience, issuer, tenant, or expiry does not match this PoC.") from None


def check_resource_claims(token, tenant, agent, now):
    try:
        claims, ttl = token_claims(
            token, tenant, (OBSERVABILITY_APP, f"api://{OBSERVABILITY_APP}"), now
        )
        callers = [claims[key] for key in ("appid", "azp") if key in claims]
        roles = claims.get("roles")
        if (not callers or any(guid(caller) != agent for caller in callers)
                or "scp" in claims or not isinstance(roles, list)
                or OBSERVABILITY_ROLE not in roles):
            raise ValueError
        return ttl
    except (ValueError, TypeError, PocError):
        raise PocError("Agent token audience, role, identity, or expiry does not match this PoC.") from None


class BlueprintS2STokenResolver:
    def __init__(self, tenant_id, blueprint_id, agent_id, secret, http=None,
                 monotonic=time.monotonic, wall_clock=time.time):
        self.tenant_id = guid(tenant_id)
        self.blueprint_id = guid(blueprint_id)
        self.agent_id = guid(agent_id)
        if self.blueprint_id == self.agent_id:
            raise PocError("Blueprint appId and child agent appId must differ.")
        if not isinstance(secret, str) or not secret.strip() or len(secret) > 8192:
            raise PocError("A blueprint development credential is required.")
        self._secret = secret
        self._http = http or Https()
        self._monotonic = monotonic
        self._wall_clock = wall_clock
        self._token = None
        self._expires_at = 0
        self._lock = threading.Lock()
        self._url = f"https://login.microsoftonline.com/{self.tenant_id}/oauth2/v2.0/token"

    def _exchange(self, form):
        result = self._http.post_json(
            self._url, urllib.parse.urlencode(form).encode("utf-8"),
            {"Content-Type": "application/x-www-form-urlencoded"}, limit=65536,
        )
        token = result.get("access_token")
        token_type = result.get("token_type")
        if (not isinstance(token, str) or not token or len(token) > 32768
                or any(char.isspace() for char in token)
                or not isinstance(token_type, str) or token_type.lower() != "bearer"):
            raise PocError("Entra returned an invalid token response; body withheld.")
        return token, lifetime(result.get("expires_in"))

    def __call__(self, agent_id, tenant_id):
        if (guid(agent_id), guid(tenant_id)) != (self.agent_id, self.tenant_id):
            raise PocError("Exporter identity does not match the configured child agent.")
        with self._lock:
            if not self._secret:
                raise PocError("The development credential has been cleared.")
            if self._token and self._monotonic() < self._expires_at - 60:
                return self._token
            self._token = None
            exchange_started = self._monotonic()
            exchange, exchange_ttl = self._exchange({
                "grant_type": "client_credentials",
                "client_id": self.blueprint_id,
                "client_secret": self._secret,
                "scope": "api://AzureADTokenExchange/.default",
                "fmi_path": self.agent_id,
            })
            token_claims(exchange, self.tenant_id, ("api://AzureADTokenExchange",), self._wall_clock())
            if exchange_started + exchange_ttl <= self._monotonic():
                raise PocError("Exchange token expired before it could be used.")
            started = self._monotonic()
            resource, ttl = self._exchange({
                "grant_type": "client_credentials",
                "client_id": self.agent_id,
                "client_assertion_type": "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
                "client_assertion": exchange,
                "scope": OBSERVABILITY_SCOPE,
            })
            claims_ttl = check_resource_claims(
                resource, self.tenant_id, self.agent_id, self._wall_clock()
            )
            self._expires_at = min(started + ttl, self._monotonic() + claims_ttl)
            if self._expires_at <= self._monotonic():
                raise PocError("Agent token expired before it could be used.")
            self._token = resource
            return resource

    def clear(self):
        with self._lock:
            self._token = None
            self._secret = ""
            self._expires_at = 0
