"""Hosted entry point. Importing this module does not start or authenticate anything."""

import os

from poc_hosted.application import FoundryModel, HostedApplication
from poc_hosted.identity import platform_credential
from poc_hosted.limits import RequestBodyLimit
from poc_hosted.settings import Settings, prepare_environment
from poc_hosted.telemetry import configure


def create_app():
    settings = Settings.from_env(os.environ)
    prepare_environment(os.environ, settings.export)
    from agent_framework.observability import disable_instrumentation
    from azure.ai.agentserver.responses import (
        InMemoryResponseProvider, ResponsesAgentServerHost, ResponsesServerOptions, TextResponse,
    )

    disable_instrumentation()
    credential = platform_credential()
    telemetry = None
    try:
        telemetry = configure(settings, credential)
        host = ResponsesAgentServerHost(
            configure_observability=None,
            access_log=None,
            store=InMemoryResponseProvider(),
            options=ResponsesServerOptions(resilient_background=False),
        )
        host.add_middleware(RequestBodyLimit, max_bytes=4096)
        application = HostedApplication(settings, FoundryModel(settings, credential), telemetry, TextResponse)

        @host.response_handler
        async def handler(request, context, cancellation_signal):
            return await application.handle(request, context, cancellation_signal)

        return host, telemetry, credential
    except BaseException:
        if telemetry is not None:
            telemetry.close()
        credential.close()
        raise


def main():
    host, telemetry, credential = create_app()
    try:
        host.run()
    finally:
        try:
            telemetry.close()
        finally:
            credential.close()


if __name__ == "__main__":
    main()
