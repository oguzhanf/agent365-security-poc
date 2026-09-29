"""Operator-only live probe; not packaged in the hosted agent source directory."""

import argparse
from urllib.parse import urlsplit


def main():
    parser = argparse.ArgumentParser(description="Send one synthetic request to an approved hosted agent.")
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--agent", required=True)
    parser.add_argument("--authorize-live-request", action="store_true")
    args = parser.parse_args()
    url = urlsplit(args.endpoint)
    if (url.scheme != "https" or not (url.hostname or "").endswith(".services.ai.azure.com")
            or url.username or url.password or url.query or url.fragment):
        parser.error("Use the approved public-cloud Foundry project endpoint.")
    if not args.authorize_live_request:
        parser.error("This request incurs model usage. Explicit authorization is required.")
    from azure.ai.projects import AIProjectClient
    from azure.identity import AzureCliCredential

    # This is the human caller credential, NEVER the hosted exporter credential.
    with AzureCliCredential() as credential:
        with AIProjectClient(endpoint=args.endpoint, credential=credential) as project:
            with project.get_openai_client(agent_name=args.agent) as client:
                response = client.responses.create(
                    input="synthetic:add", store=False, stream=False,
                )
                print(response.output_text)


if __name__ == "__main__":
    main()
