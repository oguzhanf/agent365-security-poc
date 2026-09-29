"""Command-line entry points. No network access or telemetry."""

import argparse
import json
import sys

from .core import EvidenceError, EvidenceStore, KINDS, PHASES, STATUSES, report_text


def parser():
    command = argparse.ArgumentParser(
        prog="python -m poc_evidence",
        description="Record local evidence metadata. Check integrity and catalogue acceptance.",
    )
    subcommands = command.add_subparsers(dest="command", required=True)
    for name, help_text in (
        ("init", "Create an empty evidence store. Never replace existing evidence."),
        ("record", "Append a phase result or an approved exclusion."),
        ("report", "Report acceptance after checking all stored artifact hashes."),
        ("verify", "Check the manifest and all stored artifact hashes."),
    ):
        child = subcommands.add_parser(name, help=help_text, description=help_text)
        child.add_argument("--evidence-dir", required=True, help="Absolute evidence root outside the source repository.")
        child.add_argument(
            "--catalogue", required=name == "init",
            help="Catalogue JSON. Required for init. Other commands reject changed catalogue content.",
        )
        child.add_argument("--format", choices=("text", "json"), default="text", help="Output format. Default: text.")
        if name == "record":
            child.add_argument("--scenario", required=True, help="Catalogue scenario id.")
            child.add_argument("--reason", required=True, help="Short result or exclusion reason. Do not include secrets.")
            child.add_argument(
                "--agent",
                help="Fixed alias for this scenario and evidence kind. Use a new store for another agent. Do not use secrets.",
            )
            child.add_argument("--phase", choices=PHASES)
            child.add_argument("--result", choices=STATUSES)
            child.add_argument("--evidence-kind", choices=KINDS, help="Required for a phase result. No inferred product evidence.")
            child.add_argument("--artifact", action="append", default=[], help="Relative artifact path. Repeat for multiple files.")
            child.add_argument("--correlation-id", help="Optional nonsecret correlation id, at most 128 characters.")
            child.add_argument("--expected-revision", type=int, help="Reject the update if the revision differs.")
            child.add_argument("--exclude", action="store_true", help="Append an exclusion instead of a result.")
            child.add_argument("--approved-by", help="Approver alias. Required with --exclude.")
            child.add_argument("--approved-date", help="UTC approval date: YYYY-MM-DD. Required with --exclude.")
    return command


def _record(store, args):
    if args.exclude:
        if any(value is not None for value in (args.agent, args.phase, args.result, args.evidence_kind, args.correlation_id)) or args.artifact:
            raise EvidenceError("An exclusion cannot include phase result or artifact fields.")
        if args.approved_by is None or args.approved_date is None:
            raise EvidenceError("An exclusion requires --approved-by and --approved-date.")
        return store.exclude(
            args.scenario, args.reason, args.approved_by, args.approved_date, args.expected_revision,
        )
    if args.approved_by is not None or args.approved_date is not None:
        raise EvidenceError("Approval fields require --exclude.")
    if any(value is None for value in (args.agent, args.phase, args.result, args.evidence_kind)):
        raise EvidenceError("A result requires --agent, --phase, --result and --evidence-kind.")
    return store.record(
        args.scenario, args.agent, args.phase, args.result, args.reason,
        args.evidence_kind, args.artifact, args.correlation_id, args.expected_revision,
    )


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        store = EvidenceStore(args.evidence_dir, args.catalogue)
        if args.command == "init":
            manifest = store.initialize()
            result = {"initialized": True, "revision": manifest["revision"]}
            text = "Evidence store initialized. No test result was recorded."
        elif args.command == "record":
            result = _record(store, args)
            text = "Exclusion recorded. No product pass was created." if args.exclude else "Phase result recorded. Use report to check scenario acceptance."
        elif args.command == "verify":
            result = store.verify()
            text = "Evidence integrity: valid. " + result["scope"]
        else:
            result = store.report()
            text = report_text(result)
        print(json.dumps(result, ensure_ascii=False, indent=2) if args.format == "json" else text)
        if args.command == "report" and not result["acceptance"]["achieved"]:
            return 1
        return 0
    except (EvidenceError, OSError, ValueError) as exc:
        if args.format == "json":
            print(json.dumps({"error": str(exc), "acceptance_achieved": False}, ensure_ascii=False))
        else:
            print(f"Error: {exc}", file=sys.stderr)
        return 2
