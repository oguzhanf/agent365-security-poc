"""Synthetic Claude Managed Agents beta lab. All commands default to no network."""

import argparse
import copy
import http.client
import json
import os
import re
import sys
import time
from urllib.parse import urlencode

HOST = "api.anthropic.com"
BETA = "managed-agents-2026-04-01"
SYSTEM = (
    "You are a synthetic arithmetic lab assistant. Answer the supplied arithmetic "
    "question briefly. Do not request personal information or use tools."
)
PROMPT = "Synthetic lab: what is 2 + 2? Reply with one short sentence."
NETWORK = {
    "type": "limited",
    "allowed_hosts": [],
    "allow_mcp_servers": False,
    "allow_package_managers": False,
}
PREFIXES = {"workspace": "wrkspc", "agent": "agent", "environment": "env", "session": "sesn"}


class DemoError(Exception):
    pass


def resource_id(value, kind):
    if not isinstance(value, str) or not re.fullmatch(
        re.escape(PREFIXES[kind]) + r"_[A-Za-z0-9]{8,100}", value
    ):
        raise DemoError("Invalid " + kind + " ID.")
    return value


def event_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value):
        raise DemoError("Invalid event ID.")
    return value


def headers(workspace, key="[REDACTED: ANTHROPIC_API_KEY]"):
    return {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": BETA,
        "anthropic-workspace-id": resource_id(workspace, "workspace"),
        "x-api-key": key,
    }


class Client:
    def __init__(self, workspace, api_key, connection_factory=None):
        self.workspace = resource_id(workspace, "workspace")
        if not api_key or api_key.strip() != api_key or "\r" in api_key or "\n" in api_key:
            raise DemoError("Set a workspace-scoped ANTHROPIC_API_KEY in the process environment.")
        self._key = api_key
        self._connection_factory = connection_factory or http.client.HTTPSConnection

    def request(self, method, path, body=None, timeout=15):
        if not path.startswith("/v1/") or "\r" in path or "\n" in path:
            raise DemoError("Invalid API path.")
        connection = None
        try:
            connection = self._connection_factory(HOST, timeout=timeout)
            payload = None if body is None else json.dumps(body).encode("utf-8")
            connection.request(method, path, body=payload, headers=headers(self.workspace, self._key))
            response = connection.getresponse()
            # Do not follow redirects or echo provider error bodies, which can contain request data.
            if not 200 <= response.status < 300:
                raise DemoError("Anthropic HTTP error " + str(response.status) + "; body suppressed.")
            data = response.read(1048577)
            if len(data) > 1048576:
                raise DemoError("Provider response exceeded the one-megabyte limit.")
            result = json.loads(data)
            if not isinstance(result, dict):
                raise DemoError("Provider returned an unexpected JSON shape.")
            return result
        except (OSError, http.client.HTTPException):
            raise DemoError("Provider transport failed. Outcome may be unknown; do not retry creation blindly.") from None
        except (ValueError, UnicodeError):
            raise DemoError("Provider returned invalid JSON; body suppressed.") from None
        finally:
            if connection is not None:
                connection.close()


def request_plan(method, path, body=None):
    return {"method": method, "url": "https://" + HOST + path, "body": body}


def plans(args):
    resource_id(args.workspace_id, "workspace")
    command = args.command
    if command == "create-agent":
        if not re.fullmatch(r"claude-[A-Za-z0-9.-]{1,100}", args.model):
            raise DemoError("Choose an approved Claude model ID, not an endpoint or credential.")
        return [request_plan("POST", "/v1/agents", {
            "name": "A365 synthetic arithmetic lab",
            "model": args.model,
            "system": SYSTEM,
            "description": "Synthetic Agent 365 inventory demonstration.",
            "tools": [],
            "mcp_servers": [],
            "skills": [],
            "metadata": {"purpose": "agent365-security-poc", "data": "synthetic"},
        })]
    if command == "create-environment":
        return [request_plan("POST", "/v1/environments", {
            "name": "a365-synthetic-isolated",
            "description": "No external hosts, packages, credentials, or MCP servers.",
            "config": {"type": "cloud", "networking": copy.deepcopy(NETWORK)},
            "metadata": {"purpose": "agent365-security-poc", "data": "synthetic"},
        })]
    if command == "run":
        agent = resource_id(args.agent_id, "agent")
        environment = resource_id(args.environment_id, "environment")
        if not 1 <= args.agent_version <= 1000000:
            raise DemoError("Agent version must be a positive integer.")
        return [
            request_plan("GET", "/v1/environments/" + environment),
            request_plan("POST", "/v1/sessions", {
                "agent": {"type": "agent", "id": agent, "version": args.agent_version},
                "environment_id": environment,
                "title": "A365 synthetic arithmetic test",
                "budget": {
                    "type": "limit",
                    "max_list_cost": {"amount": "50", "currency": "USD"},
                },
            }),
            request_plan("GET", "/v1/sessions/{new_session_id}"),
            request_plan("POST", "/v1/sessions/{new_session_id}/events", {
                "events": [{"type": "user.message", "content": [{"type": "text", "text": PROMPT}]}],
            }),
            request_plan("GET", "/v1/sessions/{new_session_id}/events?order=asc&limit=100"),
        ]
    if command == "watch":
        session = resource_id(args.session_id, "session")
        event_id(args.event_id)
        return [request_plan("GET", "/v1/sessions/" + session + "/events?order=asc&limit=100")]
    if command == "delete-session":
        return [request_plan("DELETE", "/v1/sessions/" + resource_id(args.session_id, "session"))]
    if command == "delete-environment":
        return [request_plan("DELETE", "/v1/environments/" + resource_id(args.environment_id, "environment"))]
    if command == "archive-agent":
        return [request_plan("POST", "/v1/agents/" + resource_id(args.agent_id, "agent") + "/archive")]
    raise DemoError("Unsupported operation.")


def assert_safe_session(session, agent_id, version):
    agent = session.get("agent", {})
    if not isinstance(agent, dict):
        raise DemoError("Session snapshot lacks its resolved agent.")
    if agent.get("id") != agent_id or agent.get("version") != version or agent.get("system") != SYSTEM:
        raise DemoError("Session does not match the pinned synthetic lab agent. No event was sent.")
    if any(agent.get(field) != [] for field in ("tools", "mcp_servers", "skills")) or agent.get("multiagent"):
        raise DemoError("Session enables tools, skills, MCP, or other agents. No event was sent.")


def assert_safe_environment(environment, expected_id):
    config = environment.get("config")
    if (environment.get("id") != expected_id or environment.get("archived_at") is not None
            or environment.get("metadata") != {"purpose": "agent365-security-poc", "data": "synthetic"}
            or not isinstance(config, dict) or config.get("type") != "cloud"
            or config.get("networking") != NETWORK):
        raise DemoError("Environment does not match the isolated synthetic lab. No session was created.")
    packages = config.get("packages")
    if (not isinstance(packages, dict)
            or any(packages.get(name) != [] for name in ("apt", "cargo", "gem", "go", "npm", "pip"))
            or set(packages) - {"type", "apt", "cargo", "gem", "go", "npm", "pip"}):
        raise DemoError("Environment has packages or an unknown package configuration. No session was created.")


def poll(client, session, sent_event, max_polls=20, poll_seconds=2, deadline_seconds=120,
         sleep=time.sleep, clock=time.monotonic):
    resource_id(session, "session")
    event_id(sent_event)
    if not 1 <= max_polls <= 60 or not 0 <= poll_seconds <= 10 or not 1 <= deadline_seconds <= 300:
        raise DemoError("Polling limits are outside the permitted bounds.")
    deadline = clock() + deadline_seconds
    for attempt in range(max_polls):
        cursor = None
        seen_cursors = set()
        matched = False
        message_count = 0
        for page_number in range(5):
            remaining = deadline - clock()
            if remaining <= 0:
                raise DemoError("Polling deadline reached. Remote work may continue; no completion is claimed.")
            query = {"order": "asc", "limit": 100}
            if cursor:
                query["page"] = cursor
            result = client.request(
                "GET", "/v1/sessions/" + session + "/events?" + urlencode(query),
                timeout=min(15, remaining),
            )
            if clock() >= deadline:
                raise DemoError("Polling deadline reached. Remote work may continue; no completion is claimed.")
            events = result.get("data")
            if not isinstance(events, list):
                raise DemoError("Event list response is malformed.")
            for event in events:
                if not isinstance(event, dict):
                    raise DemoError("Event response is malformed.")
                kind = event.get("type")
                if kind in ("session.status_terminated", "session.deleted"):
                    raise DemoError("Session terminated or was deleted. No successful turn is claimed.")
                if event.get("id") == sent_event and kind == "user.message":
                    matched = True
                if not matched:
                    continue
                if kind == "agent.message":
                    message_count += 1
                if kind == "session.error":
                    error = event.get("error")
                    retry_status = error.get("retry_status") if isinstance(error, dict) else None
                    retry = retry_status.get("type") if isinstance(retry_status, dict) else None
                    if retry != "retrying":
                        raise DemoError("Session reported an execution error; provider text suppressed.")
                if kind == "session.status_idle":
                    stop_reason = event.get("stop_reason")
                    reason = stop_reason.get("type") if isinstance(stop_reason, dict) else None
                    if reason != "end_turn" or message_count == 0:
                        raise DemoError("Session stopped without a verified message and end_turn.")
                    return {"status": "end_turn_observed", "session_id": session,
                            "agent_message_count": message_count, "model_output": "not printed or forwarded"}
            cursor = result.get("next_page")
            if not cursor:
                break
            if not isinstance(cursor, str) or len(cursor) > 4096 or cursor in seen_cursors:
                raise DemoError("Invalid or repeated event pagination cursor.")
            seen_cursors.add(cursor)
        else:
            raise DemoError("Event pagination limit reached; no completion is claimed.")
        if attempt + 1 < max_polls:
            remaining = deadline - clock()
            if remaining <= 0:
                raise DemoError("Polling deadline reached. Remote work may continue; no completion is claimed.")
            sleep(min(poll_seconds, remaining))
    raise DemoError("Polling limit reached. Remote work may continue; inspect or delete this exact session.")


def execute(args, plan, client, emit):
    command = args.command
    if command == "watch":
        return poll(client, args.session_id, args.event_id, args.max_polls)
    first = plan[0]
    if command == "run":
        environment = client.request("GET", "/v1/environments/" + args.environment_id)
        assert_safe_environment(environment, args.environment_id)
        first = plan[1]
    result = client.request(first["method"], first["url"].removeprefix("https://" + HOST), first["body"])
    kind = {
        "create-agent": "agent", "create-environment": "environment", "run": "session",
        "delete-session": "session", "delete-environment": "environment", "archive-agent": "agent",
    }[command]
    identifier = resource_id(result.get("id"), kind)
    emit({kind + "_id": identifier})
    if command == "create-agent":
        version = result.get("version")
        if type(version) is not int or version < 1:
            raise DemoError("Agent created, but its version is missing. Inspect it before running.")
        return {"agent_id": identifier, "version": version}
    if command in ("delete-session", "delete-environment"):
        expected_id = args.session_id if kind == "session" else args.environment_id
        if identifier != expected_id or result.get("type") != kind + "_deleted":
            raise DemoError("Provider did not confirm deletion of the exact requested object.")
        return {"status": "deleted", kind + "_id": identifier}
    if command == "archive-agent":
        if identifier != args.agent_id or not result.get("archived_at"):
            raise DemoError("Provider did not confirm archival of the exact requested agent.")
        return {"status": "archived_not_deleted", "agent_id": identifier}
    if command == "run":
        session = client.request("GET", "/v1/sessions/" + identifier)
        if session.get("id") != identifier or session.get("environment_id") != args.environment_id:
            raise DemoError("Session identity or environment mismatch. No event was sent.")
        if session.get("status") != "idle" or session.get("vault_ids") != []:
            raise DemoError("Session is not an idle, credential-free lab session. No event was sent.")
        assert_safe_session(session, args.agent_id, args.agent_version)
        receipt = client.request("POST", "/v1/sessions/" + identifier + "/events", plan[3]["body"])
        sent = receipt.get("data", [])
        if (not isinstance(sent, list) or len(sent) != 1 or not isinstance(sent[0], dict)
                or sent[0].get("type") != "user.message"):
            raise DemoError("Event receipt is unexpected. Work may have started; do not send again blindly.")
        sent_id = event_id(sent[0].get("id"))
        emit({"session_id": identifier, "event_id": sent_id, "status": "accepted_not_complete"})
        return poll(client, identifier, sent_id, args.max_polls)
    return {kind + "_id": identifier, "status": "created"}


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    commands = result.add_subparsers(dest="command", required=True)
    for name in ("create-agent", "create-environment", "run", "watch",
                 "delete-session", "delete-environment", "archive-agent"):
        command = commands.add_parser(name)
        command.add_argument("--workspace-id", required=True, help="Non-default wrkspc_... ID.")
        command.add_argument("--apply", action="store_true", help="Authorize only this operation's API requests.")
        if name == "create-agent":
            command.add_argument("--model", required=True, help="Approved and available Claude model ID.")
        if name in ("run", "archive-agent"):
            command.add_argument("--agent-id", required=True)
        if name in ("run", "delete-environment"):
            command.add_argument("--environment-id", required=True)
        if name == "run":
            command.add_argument("--agent-version", type=int, required=True)
        if name in ("watch", "delete-session"):
            command.add_argument("--session-id", required=True)
        if name == "watch":
            command.add_argument("--event-id", required=True, help="Exact accepted user.message event ID.")
        if name in ("run", "watch"):
            command.add_argument("--max-polls", type=int, choices=range(1, 61), default=20)
    return result


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        plan = plans(args)
        print(json.dumps({
            "mode": "apply" if args.apply else "dry-run",
            "headers": headers(args.workspace_id),
            "requests": plan,
            "notes": [
                "No network or credential read occurs without --apply.",
                "{new_session_id} is replaced only by the create-session response ID.",
                "Polling follows at most five pages per attempt and has a 120-second deadline.",
                "COST: Running sessions and inference can incur charges.",
                "The 50-cent list-cost budget can overshoot during an in-flight request.",
                "Stateful beta: not eligible for ZDR or HIPAA BAA coverage.",
                "Delete-session and delete-environment are permanent. Agent archive is irreversible, not deletion.",
            ],
        }, indent=2))
        if not args.apply:
            return 0
        client = Client(args.workspace_id, os.environ.get("ANTHROPIC_API_KEY"))
        emit = lambda value: print(json.dumps(value), flush=True)
        emit(execute(args, plan, client, emit))
        return 0
    except DemoError as error:
        print("ERROR: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
