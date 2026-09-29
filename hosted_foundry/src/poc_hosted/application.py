"""The handler performs a local arithmetic tool and a real, bounded model call."""

import asyncio
import os

from .settings import identifier

SYNTHETIC_INPUT = "synthetic:add"
MAX_INPUT_BYTES = 64
MAX_OUTPUT_CHARS = 2048
SYSTEM_INSTRUCTIONS = (
    "You are an isolated synthetic arithmetic demo. Explain only the supplied "
    "synthetic addition result in one short sentence. Do not request files, "
    "personal data, credentials, or external tools."
)


class RequestRejected(ValueError):
    pass


async def bounded_call(coro, cancellation, shutdown, timeout):
    work = asyncio.create_task(coro)
    cancel = asyncio.create_task(cancellation.wait())
    stopping = asyncio.create_task(shutdown.wait())
    tasks = (work, cancel, stopping)
    try:
        done, _ = await asyncio.wait(tasks, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
        if cancel in done or stopping in done:
            raise asyncio.CancelledError()
        if work not in done:
            raise TimeoutError("Synthetic operation timed out.")
        return await work
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


class FoundryModel:
    def __init__(self, settings, credential):
        self.settings = settings
        self.credential = credential

    async def run(self, prompt, call_id):
        from agent_framework import Agent
        from agent_framework.foundry import FoundryChatClient
        from azure.ai.agentserver.core.platform_headers import FOUNDRY_CALL_ID

        client = FoundryChatClient(
            project_endpoint=self.settings.endpoint,
            model=self.settings.model,
            credential=self.credential,
        )
        async with Agent(
            client=client, instructions=SYSTEM_INSTRUCTIONS,
            default_options={"store": False, "max_tokens": 256},
        ) as agent:
            response = await agent.run(
                prompt, client_kwargs={"extra_headers": {FOUNDRY_CALL_ID: call_id}},
            )
        if not isinstance(response.text, str) or not response.text.strip():
            raise RuntimeError("Model returned no text.")
        return response.text


class HostedApplication:
    def __init__(self, settings, model, telemetry, text_response, env=None):
        self.settings = settings
        self.model = model
        self.telemetry = telemetry
        self.text_response = text_response
        self.env = os.environ if env is None else env
        self.active = 0

    def synthetic_add(self, left, right):
        with self.telemetry.tool():
            if type(left) is not int or type(right) is not int or abs(left) > 10 or abs(right) > 10:
                raise RequestRejected("Only small synthetic integers are supported.")
            return left + right

    async def handle(self, request, context, cancellation_signal):
        # Admission has no await: the event-loop counter cannot race here.
        if self.active >= self.settings.max_concurrency:
            raise RequestRejected("Synthetic demo is busy; retry later.")
        self.active += 1
        try:
            return await bounded_call(
                self._execute(request, context, cancellation_signal),
                cancellation_signal, context.shutdown, self.settings.timeout_seconds,
            )
        finally:
            self.active -= 1

    async def _execute(self, request, context, cancellation_signal):
        if cancellation_signal.is_set() or context.shutdown.is_set():
            raise asyncio.CancelledError()
        # Reject files, reference items, caller instructions and history before resolving input.
        if (
            not isinstance(request.input, str)
            or len(request.input.encode("utf-8")) > MAX_INPUT_BYTES
            or request.input != SYNTHETIC_INPUT
            or getattr(request, "instructions", None)
            or getattr(request, "tools", None)
            or getattr(request, "previous_response_id", None)
            or getattr(request, "background", False)
            or getattr(request, "store", None) is not False
        ):
            raise RequestRejected("Use input='synthetic:add', store=false, and no tools, history, or instructions.")
        if await context.get_input_text() != SYNTHETIC_INPUT:
            raise RequestRejected("Input context mismatch.")
        conversation_id = identifier(context.conversation_chain_id, "conversation chain ID")
        session_id = identifier(self.env.get("FOUNDRY_AGENT_SESSION_ID"), "platform session ID")
        call_id = context.platform_context.call_id
        if not isinstance(call_id, str) or not call_id or len(call_id) > 4096 or "\r" in call_id or "\n" in call_id:
            raise RequestRejected("Platform Responses 2.0 call context is required.")
        with self.telemetry.invocation(conversation_id, session_id) as trace_id:
            result = self.synthetic_add(2, 3)
            text = await self.model.run(
                f"Synthetic inputs: 2 and 3. Local synthetic_add result: {result}. Explain the result.",
                call_id,
            )
            if not isinstance(text, str) or not text.strip() or len(text) > MAX_OUTPUT_CHARS:
                raise RuntimeError("Invalid bounded model response.")
        return self.text_response(
            context, request,
            text=f"{text}\ntrace_id={trace_id}\nconversation_id={conversation_id}",
        )
