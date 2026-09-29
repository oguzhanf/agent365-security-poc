import argparse
import json
import os
import sys

from .agent import QUESTIONS, run_agent, run_smoke
from .safety import PocError, isolate_environment, required_env


def parser():
    result = argparse.ArgumentParser(
        description="Outbound-only synthetic Agent365 PoC. Default: no-network local_simulation.",
        epilog="One fresh process per mode. Local tool denials are application logic, not Microsoft enforcement.",
    )
    result.add_argument("--instrument", action="store_true", help="Emit metadata-only SDK spans to console; no export.")
    result.add_argument("--live-model", action="store_true", help="Explicitly authorize Azure OpenAI model calls and model credential use.")
    result.add_argument("--export-agent365", action="store_true", help="Explicitly authorize blueprint S2S auth and Agent365 export; requires --live-model.")
    result.add_argument("--scenario", choices=QUESTIONS, default="approval")
    result.add_argument("--max-rounds", type=int, choices=range(1, 7), default=4)
    result.add_argument("--endpoint", help="HTTPS Azure OpenAI account endpoint; or AZURE_OPENAI_ENDPOINT.")
    result.add_argument("--deployment", help="Existing tool-capable model deployment; or AZURE_OPENAI_DEPLOYMENT.")
    result.add_argument("--model-tenant-id", help="Model credential tenant GUID; or MODEL_TENANT_ID.")
    result.add_argument("--api-version", default="v1", help="Stable REST version (default: v1); dated GA versions also accepted.")
    return result


def main(argv=None):
    args = parser().parse_args(argv)
    telemetry = None
    resolver = None
    try:
        if args.instrument or args.live_model or args.export_agent365:
            isolate_environment()
        if args.export_agent365 and not args.live_model:
            raise PocError("--export-agent365 requires --live-model; synthetic smoke never exports.")
        if not args.live_model and any((args.endpoint, args.deployment, args.model_tenant_id)):
            raise PocError("Model options require explicit --live-model.")
        model = None
        if args.live_model:
            from .model import AzureOpenAI
            model = AzureOpenAI(
                args.endpoint or required_env("AZURE_OPENAI_ENDPOINT"),
                args.deployment or required_env("AZURE_OPENAI_DEPLOYMENT"),
                args.model_tenant_id or required_env("MODEL_TENANT_ID"), args.api_version,
            )
        if args.export_agent365:
            from .auth import BlueprintS2STokenResolver
            required_env("A365_BLUEPRINT_CLIENT_SECRET")
            resolver = BlueprintS2STokenResolver(
                required_env("A365_TENANT_ID"), required_env("A365_BLUEPRINT_ID"),
                required_env("A365_AGENT_ID"), os.environ.pop("A365_BLUEPRINT_CLIENT_SECRET"),
            )
            if model.tenant_id != resolver.tenant_id:
                raise PocError("Model and Agent365 tenant IDs must match for this isolated PoC.")
            # Fail before model calls or span export, rather than hiding auth failure in SDK logs.
            resolver(resolver.agent_id, resolver.tenant_id)
        if args.instrument or args.live_model:
            from .telemetry import Telemetry
            telemetry = Telemetry(model.deployment if model else "synthetic-no-model", resolver)
        result = (run_agent(model, args.scenario, args.max_rounds, telemetry) if model
                  else run_smoke(telemetry))
        if telemetry:
            result.update(telemetry.finish())
        else:
            result.update({"telemetry": "disabled", "ingestion_verified": False})
        print(json.dumps(result, ensure_ascii=True))
        return 0
    except PocError as error:
        result = {"status": "failed", "error": str(error), "ingestion_verified": False}
        if telemetry:
            result.update({"trace_id": telemetry.trace_id, "conversation_id": telemetry.conversation_id})
        print(json.dumps(result), file=sys.stderr)
        return 2
    finally:
        try:
            if telemetry:
                telemetry.close()
        finally:
            if resolver:
                resolver.clear()


if __name__ == "__main__":
    raise SystemExit(main())
