import copy
import hashlib
import io
import json
import os
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

from poc_evidence import EvidenceError, EvidenceStore, load_catalogue
from poc_evidence import core
from poc_evidence.cli import main


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        # All fixtures stay in a disposable project-local directory.
        self.temporary = tempfile.TemporaryDirectory(
            prefix=".test-evidence-", dir=Path(__file__).resolve().parent,
        )
        self.addCleanup(self.temporary.cleanup)
        self.workspace = Path(self.temporary.name)
        self.source = self.workspace / "synthetic-source"
        self.source.mkdir()
        patcher = mock.patch.object(core, "REPOSITORY_ROOT", self.source)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.catalogue_path = self.source / "catalogue.json"
        self.catalogue = {
            "schema_version": 1,
            "scenarios": [
                {"id": "A-01", "title": "Check product controls", "required": True, "layer": "identity"},
                {"id": "B2-002", "title": "Check optional controls", "required": False, "layer": "runtime"},
                {
                    "id": "HARNESS-003", "title": "Check the local harness", "required": True,
                    "layer": "offline", "validation_kind": "local_simulation",
                },
            ],
        }
        self.write_catalogue()
        self.root = self.workspace / "evidence"
        self.store = EvidenceStore(self.root, self.catalogue_path)

    def write_catalogue(self):
        self.catalogue_path.write_text(json.dumps(self.catalogue), encoding="utf-8")

    def initialize(self):
        self.store.initialize()

    def artifact(self, name="artifacts/result.txt", content=b"Synthetic test output.\n"):
        path = self.root.joinpath(*name.split("/"))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return name

    def record(self, scenario="A-01", phase="positive", result="PASS", kind="live_product",
               artifacts=None, agent="test-agent", **kwargs):
        if artifacts is None:
            artifacts = [self.artifact(f"artifacts/{scenario}-{phase}-{kind}.txt")]
        return self.store.record(
            scenario, agent, phase, result, "Synthetic result.", kind, artifacts, **kwargs,
        )

    def pass_scenario(self, scenario="A-01", kind="live_product"):
        self.record(scenario, "positive", kind=kind)
        self.record(scenario, "negative", kind=kind)

    def manifest(self):
        return json.loads(self.store.manifest_path.read_text(encoding="utf-8"))

    def write_manifest(self, value):
        self.store.manifest_path.write_text(json.dumps(value), encoding="utf-8")

    def case(self, scenario="A-01"):
        return next(case for case in self.store.report()["scenarios"] if case["id"] == scenario)

    def cli(self, *arguments):
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            result = main(list(arguments))
        return result, stdout.getvalue(), stderr.getvalue()

    def test_catalogue_accepts_all_matching_ids_and_additional_fields(self):
        ids = ("A-00", "Z9-999", "AGENT365-01", "X" * 300 + "-42")
        self.catalogue["scenarios"] = [
            {"id": item, "title": "Synthetic case", "required": True, "setup": ["Synthetic setup."]}
            for item in ids
        ]
        self.write_catalogue()
        result = load_catalogue(self.catalogue_path)
        self.assertEqual(set(ids), {item["id"] for item in result["scenarios"]})
        self.assertTrue(all(item["validation_kind"] == "live_product" for item in result["scenarios"]))
        self.assertTrue(all(item["layer"] == "unspecified" for item in result["scenarios"]))

    def test_catalogue_full_shape_is_supported_without_copying_body_fields(self):
        scenario = self.catalogue["scenarios"][0]
        for field in (
            "family", "priority", "availability", "prerequisites", "setup", "positive_steps",
            "negative_steps", "expected", "evidence", "pass_criteria", "value", "cleanup", "sources",
        ):
            scenario[field] = ["Synthetic content that must not enter the manifest."]
        self.write_catalogue()
        store = EvidenceStore(self.root, self.catalogue_path)
        store.initialize()
        raw = store.manifest_path.read_text(encoding="utf-8")
        self.assertNotIn("Synthetic content that must not enter the manifest.", raw)
        self.assertEqual(len(store.report()["scenarios"]), 3)

    def test_catalogue_rejects_invalid_ids(self):
        for value in ("", "a-01", "A-1", "A-0000", "1A-01", "A_B-01", "A-01\n", None, 12):
            with self.subTest(value=value):
                self.catalogue["scenarios"][0]["id"] = value
                self.write_catalogue()
                with self.assertRaises(EvidenceError):
                    load_catalogue(self.catalogue_path)

    def test_catalogue_rejects_bad_shapes_and_types(self):
        values = [
            [], {}, {"schema_version": True, "scenarios": []},
            {"schema_version": 2, "scenarios": []}, {"schema_version": 1, "scenarios": []},
            {"schema_version": 1, "scenarios": "invalid"},
            {"schema_version": 1, "scenarios": [None]},
        ]
        for value in values:
            with self.subTest(value=value):
                self.catalogue_path.write_text(json.dumps(value), encoding="utf-8")
                with self.assertRaises(EvidenceError):
                    load_catalogue(self.catalogue_path)

    def test_catalogue_requires_title_and_boolean_required(self):
        original = copy.deepcopy(self.catalogue)
        for field, value in (("title", ""), ("title", " "), ("title", 3), ("required", 1), ("required", "true")):
            with self.subTest(field=field, value=value):
                self.catalogue = copy.deepcopy(original)
                self.catalogue["scenarios"][0][field] = value
                self.write_catalogue()
                with self.assertRaises(EvidenceError):
                    load_catalogue(self.catalogue_path)
        for field in ("title", "required", "id"):
            self.catalogue = copy.deepcopy(original)
            del self.catalogue["scenarios"][0][field]
            self.write_catalogue()
            with self.assertRaises(EvidenceError):
                load_catalogue(self.catalogue_path)

    def test_catalogue_rejects_duplicates_and_unknown_validation_kind(self):
        self.catalogue["scenarios"].append(copy.deepcopy(self.catalogue["scenarios"][0]))
        self.write_catalogue()
        with self.assertRaisesRegex(EvidenceError, "Duplicate"):
            load_catalogue(self.catalogue_path)
        self.catalogue["scenarios"].pop()
        self.catalogue["scenarios"][0]["validation_kind"] = "offline"
        self.write_catalogue()
        with self.assertRaisesRegex(EvidenceError, "Validation kind"):
            load_catalogue(self.catalogue_path)

    def test_catalogue_rejects_malformed_json_duplicate_keys_and_nonfinite_values(self):
        for raw in (
            b"{", b"\xff", b'{"schema_version":1,"schema_version":1}',
            b'{"value":NaN}', b'{"value":Infinity}', b'{"value":1e999}',
        ):
            with self.subTest(raw=raw):
                self.catalogue_path.write_bytes(raw)
                with self.assertRaises(EvidenceError):
                    load_catalogue(self.catalogue_path)

    def test_init_requires_catalogue_and_absolute_external_root(self):
        for path in (None, "", "evidence", str(self.source), str(self.source / "evidence")):
            with self.subTest(path=path):
                with self.assertRaises(EvidenceError):
                    EvidenceStore(path, self.catalogue_path)
        with self.assertRaisesRegex(EvidenceError, "catalogue"):
            EvidenceStore(self.root).initialize()

    def test_init_creates_empty_valid_store_and_never_fabricates_results(self):
        self.initialize()
        report = self.store.report()
        self.assertEqual(self.store.verify()["revision"], 0)
        self.assertEqual(self.manifest()["records"], [])
        self.assertTrue(all(case["status"] == "NOT_RUN" for case in report["scenarios"]))
        self.assertFalse(report["acceptance"]["achieved"])
        self.assertEqual(report["notice"], "No live product result exists.")
        self.assertEqual(report["acceptance"]["required"]["denominator"], 2)

    def test_init_never_overwrites_existing_manifest_or_artifacts(self):
        self.initialize()
        original = self.store.manifest_path.read_bytes()
        with self.assertRaisesRegex(EvidenceError, "not empty"):
            self.initialize()
        self.assertEqual(self.store.manifest_path.read_bytes(), original)
        other = self.workspace / "existing-evidence"
        other.mkdir()
        existing = other / "original.txt"
        existing.write_bytes(b"Synthetic preexisting evidence.")
        with self.assertRaisesRegex(EvidenceError, "not empty"):
            EvidenceStore(other, self.catalogue_path).initialize()
        self.assertEqual(existing.read_bytes(), b"Synthetic preexisting evidence.")
        self.assertFalse((other / core.MANIFEST_NAME).exists())
        self.assertFalse((other / core.LOCK_NAME).exists())

    def test_init_atomic_publication_failure_leaves_no_manifest(self):
        with mock.patch.object(core.os, "link", side_effect=OSError("Synthetic link failure")):
            with self.assertRaises(EvidenceError):
                self.initialize()
        self.assertEqual(list(self.root.iterdir()), [])

    def test_record_contains_timestamp_alias_hash_and_no_artifact_body(self):
        self.initialize()
        content = b"Synthetic confidential-looking body. Do not copy this."
        path = self.artifact(content=content)
        record = self.record(artifacts=[path], correlation_id="synthetic-correlation-1")
        self.assertEqual(record["artifacts"], [{
            "path": path, "sha256": hashlib.sha256(content).hexdigest(), "size_bytes": len(content),
        }])
        self.assertEqual(record["agent_id"], "test-agent")
        self.assertEqual(record["correlation_id"], "synthetic-correlation-1")
        self.assertTrue(record["recorded_at"].endswith("Z"))
        self.assertNotIn(content.decode(), self.store.manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(self.store.verify()["records"], 1)

    def test_pass_requires_existing_nonempty_artifact(self):
        self.initialize()
        empty = self.artifact("artifacts/empty.txt", b"")
        for paths in ([], [empty], ["missing.txt"]):
            with self.subTest(paths=paths):
                with self.assertRaises(EvidenceError):
                    self.record(artifacts=paths)
        self.assertEqual(self.manifest()["revision"], 0)
        self.record(artifacts=[empty, self.artifact()])
        self.assertEqual(self.manifest()["revision"], 1)

    def test_nonpass_results_can_have_no_artifacts(self):
        self.initialize()
        for status in ("NOT_RUN", "FAIL", "BLOCKED", "NOT_APPLICABLE"):
            with self.subTest(status=status):
                self.record(result=status, artifacts=[])
                self.assertEqual(self.case()["status"], status)
                self.assertFalse(self.store.report()["acceptance"]["achieved"])
        self.assertEqual(self.store.report()["notice"], "No live product result exists.")

    def test_positive_and_negative_pass_are_both_required(self):
        self.initialize()
        self.record()
        self.assertEqual(self.case()["status"], "NOT_RUN")
        self.record(phase="control")
        self.assertEqual(self.case()["status"], "NOT_RUN")
        self.record(phase="negative")
        self.assertEqual(self.case()["status"], "PASS")
        self.assertFalse(self.store.report()["acceptance"]["achieved"])

    def test_negative_alone_does_not_pass_scenario(self):
        self.initialize()
        self.record(phase="negative")
        self.assertEqual(self.case()["status"], "NOT_RUN")

    def test_agent_binding_rejects_cross_agent_pass_before_mutation(self):
        self.initialize()
        self.record(agent="agent-a")
        original = self.store.manifest_path.read_bytes()
        with mock.patch.object(self.store, "_write") as write:
            with self.assertRaisesRegex(EvidenceError, "bound to agent alias agent-a"):
                self.record(
                    phase="negative", agent="agent-b", artifacts=["not-created.txt"],
                )
            write.assert_not_called()
        self.assertEqual(self.store.manifest_path.read_bytes(), original)
        self.assertEqual(self.case()["status"], "NOT_RUN")
        self.assertEqual(self.manifest()["revision"], 1)

    def test_agent_binding_applies_to_all_phases_results_and_exact_aliases(self):
        self.initialize()
        self.record(phase="control", result="NOT_RUN", artifacts=[], agent="agent-a")
        original = self.store.manifest_path.read_bytes()
        for phase in core.PHASES:
            for result in core.STATUSES:
                for agent in ("agent-b", "Agent-a"):
                    with self.subTest(phase=phase, result=result, agent=agent):
                        with self.assertRaisesRegex(EvidenceError, "bound to agent alias agent-a"):
                            self.record(
                                phase=phase, result=result, agent=agent, artifacts=[],
                            )
        self.assertEqual(self.store.manifest_path.read_bytes(), original)

    def test_agent_binding_is_separate_per_scenario_and_evidence_kind(self):
        self.initialize()
        for phase in ("positive", "negative"):
            self.record(phase=phase, agent="live-agent")
            self.record(phase=phase, kind="local_simulation", agent="simulation-agent")
            self.record("B2-002", phase=phase, agent="optional-agent")
        self.assertTrue(self.store.verify()["valid"])
        self.assertEqual(self.case()["status"], "PASS")
        self.assertEqual(self.case()["evidence"]["local_simulation"]["status"], "PASS")
        self.assertEqual(self.case("B2-002")["status"], "PASS")

    def test_agent_binding_allows_another_agent_in_a_new_store(self):
        self.initialize()
        self.record(agent="agent-a")
        other = EvidenceStore(self.workspace / "second-evidence", self.catalogue_path)
        other.initialize()
        (other.root / "result.txt").write_bytes(b"Synthetic second-agent result.")
        for phase in ("positive", "negative"):
            other.record(
                "A-01", "agent-b", phase, "PASS", "Synthetic result.",
                "live_product", ["result.txt"],
            )
        self.assertEqual(self.case()["status"], "NOT_RUN")
        self.assertEqual(other.report()["scenarios"][0]["status"], "PASS")

    def test_agent_binding_allows_fixed_comparative_test_set_alias(self):
        self.initialize()
        for phase in ("positive", "negative", "control"):
            self.record(phase=phase, agent="comparison-set-01")
        self.assertEqual(self.case()["status"], "PASS")
        self.assertEqual(
            {record["agent_id"] for record in self.manifest()["records"]},
            {"comparison-set-01"},
        )

    def test_agent_binding_rejects_mixed_loaded_manifest_on_every_operation(self):
        self.initialize()
        self.pass_scenario()
        manifest = self.manifest()
        manifest["records"][1]["agent_id"] = "another-agent"
        self.write_manifest(manifest)
        original = self.store.manifest_path.read_bytes()
        other = EvidenceStore(self.root)
        for operation in (
            other.verify, other.report,
            lambda: other.record(
                "A-01", "test-agent", "control", "BLOCKED",
                "Synthetic result.", "live_product",
            ),
            lambda: other.exclude("A-01", "Synthetic scope change.", "reviewer", "2026-09-18"),
        ):
            with self.subTest(operation=operation):
                with self.assertRaisesRegex(EvidenceError, "bound to agent alias"):
                    operation()
                self.assertEqual(self.store.manifest_path.read_bytes(), original)

    def test_agent_binding_checks_history_not_only_latest_phases(self):
        self.initialize()
        self.record(result="BLOCKED", artifacts=[])
        self.pass_scenario()
        manifest = self.manifest()
        manifest["records"][0]["agent_id"] = "historic-agent"
        self.write_manifest(manifest)
        with self.assertRaisesRegex(EvidenceError, "bound to agent alias historic-agent"):
            self.store.report()

    def test_latest_phase_result_replaces_old_pass_for_acceptance(self):
        self.initialize()
        self.pass_scenario()
        self.record(result="FAIL", artifacts=[])
        self.assertEqual(self.case()["status"], "FAIL")
        self.record(result="BLOCKED", artifacts=[])
        self.assertEqual(self.case()["status"], "BLOCKED")
        self.record(result="NOT_APPLICABLE", artifacts=[])
        self.assertEqual(self.case()["status"], "NOT_APPLICABLE")
        self.record(result="NOT_RUN", artifacts=[])
        self.assertEqual(self.case()["status"], "NOT_RUN")

    def test_control_failure_vetoes_a_pass(self):
        self.initialize()
        self.pass_scenario()
        self.record(phase="control", result="FAIL", artifacts=[])
        self.assertEqual(self.case()["status"], "FAIL")
        self.record(phase="control", result="BLOCKED", artifacts=[])
        self.assertEqual(self.case()["status"], "BLOCKED")

    def test_simulation_never_satisfies_product_scenario(self):
        self.initialize()
        self.pass_scenario(kind="local_simulation")
        case = self.case()
        self.assertEqual(case["status"], "NOT_RUN")
        self.assertEqual(case["evidence"]["local_simulation"]["status"], "PASS")
        report = self.store.report()
        self.assertFalse(report["acceptance"]["achieved"])
        self.assertEqual(report["notice"], "No live product result exists.")
        self.assertEqual(report["by_evidence_kind"]["live_product"]["record_count"], 0)
        self.assertEqual(report["by_evidence_kind"]["local_simulation"]["record_count"], 2)

    def test_mixed_evidence_kinds_cannot_complete_either_pair(self):
        self.initialize()
        self.record(phase="positive")
        self.record(phase="negative", kind="local_simulation")
        case = self.case()
        self.assertEqual(case["status"], "NOT_RUN")
        self.assertEqual(case["evidence"]["local_simulation"]["status"], "NOT_RUN")

    def test_simulation_failure_does_not_override_live_phase(self):
        self.initialize()
        self.pass_scenario()
        self.record(result="FAIL", kind="local_simulation", artifacts=[])
        self.assertEqual(self.case()["status"], "PASS")
        self.assertEqual(self.case()["evidence"]["local_simulation"]["status"], "FAIL")

    def test_explicit_harness_kind_requires_harness_records(self):
        self.initialize()
        self.pass_scenario("HARNESS-003")
        self.assertEqual(self.case("HARNESS-003")["status"], "NOT_RUN")
        self.pass_scenario("HARNESS-003", "local_simulation")
        self.assertEqual(self.case("HARNESS-003")["status"], "PASS")
        self.assertFalse(self.store.report()["acceptance"]["achieved"])

    def test_all_required_cases_must_pass_optional_cases_do_not_inflate_score(self):
        self.initialize()
        self.pass_scenario("B2-002")
        self.pass_scenario()
        report = self.store.report()
        self.assertEqual(report["acceptance"]["required"]["passed"], 1)
        self.assertEqual(report["acceptance"]["required"]["denominator"], 2)
        self.assertEqual(report["acceptance"]["optional"]["passed"], 1)
        self.assertFalse(report["acceptance"]["achieved"])
        self.pass_scenario("HARNESS-003", "local_simulation")
        report = self.store.report()
        self.assertTrue(report["acceptance"]["achieved"])
        self.assertEqual(report["layers"]["identity"]["status"], "PASS")
        self.assertEqual(report["layers"]["offline"]["status"], "PASS")
        self.assertIsNone(report["layers"]["runtime"]["status"])
        self.record("B2-002", result="FAIL", artifacts=[])
        self.assertTrue(self.store.report()["acceptance"]["achieved"])

    def test_required_blocked_and_not_applicable_each_prevent_acceptance(self):
        self.initialize()
        self.pass_scenario("HARNESS-003", "local_simulation")
        for result in ("BLOCKED", "NOT_APPLICABLE", "NOT_RUN", "FAIL"):
            with self.subTest(result=result):
                self.record(result=result, artifacts=[])
                report = self.store.report()
                self.assertFalse(report["acceptance"]["achieved"])
                self.assertEqual(report["acceptance"]["required"]["denominator"], 2)
                self.assertEqual(report["layers"]["identity"]["status"], result)

    def test_no_required_cases_does_not_create_vacuous_acceptance(self):
        for scenario in self.catalogue["scenarios"]:
            scenario["required"] = False
        self.write_catalogue()
        self.store = EvidenceStore(self.root, self.catalogue_path)
        self.initialize()
        self.pass_scenario()
        self.assertEqual(self.store.report()["acceptance"]["required"]["denominator"], 0)
        self.assertFalse(self.store.report()["acceptance"]["achieved"])

    def test_exclusions_change_only_agreed_denominator(self):
        self.initialize()
        self.pass_scenario("HARNESS-003", "local_simulation")
        exclusion = self.store.exclude("A-01", "Product access is unavailable.", "reviewer", "2026-09-18")
        report = self.store.report()
        self.assertFalse(report["acceptance"]["achieved"])
        self.assertEqual(report["acceptance"]["required"]["denominator"], 2)
        self.assertTrue(report["acceptance"]["agreed_required"]["achieved"])
        self.assertEqual(report["acceptance"]["agreed_required"]["denominator"], 1)
        self.assertEqual(self.case()["status"], "NOT_RUN")
        self.assertEqual(self.case()["exclusion"], exclusion)
        self.assertEqual(report["by_evidence_kind"]["live_product"]["record_count"], 0)
        self.assertEqual(len(self.manifest()["records"]), 2)

    def test_all_excluded_is_not_a_pass_and_optional_exclusions_do_not_change_denominator(self):
        self.initialize()
        self.store.exclude("B2-002", "Optional scope excluded.", "reviewer", "2026-09-18")
        self.assertEqual(self.store.report()["acceptance"]["agreed_required"]["denominator"], 2)
        self.store.exclude("A-01", "Product scope excluded.", "reviewer", "2026-09-18")
        self.store.exclude("HARNESS-003", "Harness scope excluded.", "reviewer", "2026-09-18")
        agreed = self.store.report()["acceptance"]["agreed_required"]
        self.assertEqual(agreed["denominator"], 0)
        self.assertFalse(agreed["achieved"])
        self.assertEqual(agreed["passed"], 0)

    def test_exclusion_requires_valid_approval_and_reason(self):
        self.initialize()
        for values in (
            ("A-01", "", "reviewer", "2026-09-18"),
            ("A-01", "Synthetic reason.", "", "2026-09-18"),
            ("A-01", "Synthetic reason.", "reviewer", "2026-02-30"),
            ("A-01", "Synthetic reason.", "reviewer", "2026-09-18T00:00:00Z"),
            ("UNKNOWN-01", "Synthetic reason.", "reviewer", "2026-09-18"),
        ):
            with self.subTest(values=values):
                with self.assertRaises(EvidenceError):
                    self.store.exclude(*values)
        self.assertEqual(self.manifest()["revision"], 0)
        self.store.exclude("A-01", "Synthetic reason.", "reviewer", "2026-09-18")
        with self.assertRaisesRegex(EvidenceError, "already"):
            self.store.exclude("A-01", "Synthetic reason.", "reviewer", "2026-09-18")

    def test_record_rejects_bad_fields_and_unknown_scenarios(self):
        self.initialize()
        arguments = {
            "scenario_id": "A-01", "agent_id": "agent", "phase": "positive",
            "result": "BLOCKED", "reason": "Synthetic reason.", "evidence_kind": "live_product",
        }
        for key, value in (
            ("scenario_id", "UNKNOWN-01"), ("agent_id", "Bearer synthetic data"),
            ("agent_id", "a" * 65), ("agent_id", ""), ("phase", "setup"),
            ("result", "passed"), ("reason", ""), ("evidence_kind", None),
            ("correlation_id", "x" * 129), ("artifacts", "file.txt"),
        ):
            with self.subTest(key=key, value=value):
                bad = dict(arguments, **{key: value})
                with self.assertRaises(EvidenceError):
                    self.store.record(**bad)
        self.assertEqual(self.manifest()["revision"], 0)

    def test_safe_paths_reject_traversal_absolute_drives_streams_and_internal_files(self):
        self.initialize()
        bad_paths = (
            "../outside.txt", "a/../../outside.txt", r"..\outside.txt",
            "/outside.txt", r"C:\outside.txt", r"C:relative.txt",
            r"\\server\share\file.txt", "a//file.txt", "./file.txt", "a/./file.txt",
            "a/file.txt:stream", "a/trailing.", "a/trailing ", "NUL.txt", "CON",
            "COM1.log", "LPT9.txt", "artifacts/file\x00.txt", core.MANIFEST_NAME,
            core.LOCK_NAME, ".poc-evidence-example.tmp",
        )
        for path in bad_paths:
            with self.subTest(path=path):
                with self.assertRaises(EvidenceError):
                    self.record(artifacts=[path])
        self.assertEqual(self.manifest()["revision"], 0)

    def test_windows_relative_paths_are_stored_in_canonical_form(self):
        self.initialize()
        self.artifact()
        record = self.record(artifacts=[r"artifacts\result.txt"])
        self.assertEqual(record["artifacts"][0]["path"], "artifacts/result.txt")

    def test_artifact_directory_and_duplicate_paths_are_rejected(self):
        self.initialize()
        artifact = self.artifact()
        for paths in (["artifacts"], [artifact, artifact]):
            with self.subTest(paths=paths):
                with self.assertRaises(EvidenceError):
                    self.record(artifacts=paths)
        self.assertEqual(self.manifest()["revision"], 0)

    def create_symlink(self, path, target, is_directory=False):
        try:
            path.symlink_to(target, target_is_directory=is_directory)
        except (OSError, NotImplementedError) as exc:
            self.skipTest(f"Symlink creation is not available: {exc}")

    def test_symlink_artifact_cannot_escape_root(self):
        self.initialize()
        outside = self.workspace / "outside.txt"
        outside.write_bytes(b"Synthetic outside data.")
        self.create_symlink(self.root / "link.txt", outside)
        with self.assertRaisesRegex(EvidenceError, "Symlinks"):
            self.record(artifacts=["link.txt"])

    def test_symlink_parent_cannot_escape_root(self):
        self.initialize()
        outside = self.workspace / "outside"
        outside.mkdir()
        (outside / "result.txt").write_bytes(b"Synthetic outside data.")
        self.create_symlink(self.root / "linked", outside, True)
        with self.assertRaisesRegex(EvidenceError, "Symlinks"):
            self.record(artifacts=["linked/result.txt"])

    def test_symlink_inside_root_is_also_rejected(self):
        self.initialize()
        original = self.artifact()
        self.create_symlink(self.root / "link.txt", self.root / original)
        with self.assertRaisesRegex(EvidenceError, "Symlinks"):
            self.record(artifacts=["link.txt"])

    def test_dangling_symlink_root_is_rejected(self):
        self.create_symlink(self.root, self.workspace / "missing-target", True)
        with self.assertRaisesRegex(EvidenceError, "symlink"):
            EvidenceStore(self.root, self.catalogue_path)

    def test_windows_reparse_points_are_links(self):
        info = mock.Mock(st_mode=0, st_file_attributes=0x400)
        self.assertTrue(core._is_link(info))

    def test_reparse_artifact_and_parent_are_rejected_without_symlink_privilege(self):
        self.initialize()
        artifact = self.artifact()
        original = core._is_link
        for target in (self.root / "artifacts", self.root / artifact):
            with self.subTest(target=target):
                identity = target.lstat()

                def reparse(info):
                    return (
                        (info.st_dev, info.st_ino) == (identity.st_dev, identity.st_ino)
                        or original(info)
                    )

                with mock.patch.object(core, "_is_link", side_effect=reparse):
                    with self.assertRaisesRegex(EvidenceError, "Symlinks"):
                        self.record(artifacts=[artifact])
        self.assertEqual(self.manifest()["revision"], 0)

    def test_reparse_root_and_manifest_are_rejected_without_symlink_privilege(self):
        self.initialize()
        original = core._is_link
        for target in (self.root, self.store.manifest_path):
            with self.subTest(target=target):
                identity = target.lstat()

                def reparse(info):
                    return (
                        (info.st_dev, info.st_ino) == (identity.st_dev, identity.st_ino)
                        or original(info)
                    )

                with mock.patch.object(core, "_is_link", side_effect=reparse):
                    with self.assertRaises(EvidenceError):
                        self.store.verify()

    def test_catalogue_rejects_unpaired_unicode_surrogates(self):
        self.catalogue["scenarios"][0]["title"] = "\ud800"
        self.write_catalogue()
        with self.assertRaisesRegex(EvidenceError, "UTF-8"):
            load_catalogue(self.catalogue_path)

    def test_record_verify_and_report_detect_artifact_tampering(self):
        self.initialize()
        self.pass_scenario()
        original_manifest = self.store.manifest_path.read_bytes()
        path = self.root / "artifacts" / "A-01-positive-live_product.txt"
        path.write_bytes(b"Changed synthetic data.")
        for operation in (self.store.verify, self.store.report, lambda: self.record(result="BLOCKED", artifacts=[])):
            with self.subTest(operation=operation):
                with self.assertRaisesRegex(EvidenceError, "integrity"):
                    operation()
        self.assertEqual(self.store.manifest_path.read_bytes(), original_manifest)

    def test_same_size_artifact_change_with_restored_timestamp_is_detected(self):
        self.initialize()
        artifact = self.artifact(content=b"ABC")
        self.record(artifacts=[artifact])
        path = self.root / artifact
        original = path.stat()
        path.write_bytes(b"XYZ")
        os.utime(path, ns=(original.st_atime_ns, original.st_mtime_ns))
        with self.assertRaisesRegex(EvidenceError, "integrity"):
            self.store.verify()

    def test_missing_old_artifact_still_fails_after_newer_result(self):
        self.initialize()
        self.record()
        self.record(result="BLOCKED", artifacts=[])
        (self.root / "artifacts" / "A-01-positive-live_product.txt").unlink()
        with self.assertRaises(EvidenceError):
            self.store.verify()

    def test_stale_hash_cannot_be_replaced_by_recording_changed_file(self):
        self.initialize()
        artifact = self.artifact(content=b"First synthetic output.")
        self.record(artifacts=[artifact])
        self.artifact(content=b"Second synthetic output.")
        with self.assertRaisesRegex(EvidenceError, "integrity"):
            self.record(phase="negative", artifacts=[artifact])
        self.assertEqual(self.manifest()["revision"], 1)

    def test_file_change_during_hash_is_rejected(self):
        self.initialize()
        artifact = self.artifact()
        original = self.store._file_info
        calls = 0

        def changing(relative):
            nonlocal calls
            result = original(relative)
            if relative == artifact:
                calls += 1
                if calls == 2:
                    (self.root / artifact).write_bytes(b"Changed synthetic file.")
            return result

        with mock.patch.object(self.store, "_file_info", side_effect=changing):
            with self.assertRaisesRegex(EvidenceError, "changed"):
                self.record(artifacts=[artifact])
        self.assertEqual(self.manifest()["revision"], 0)

    def test_malformed_manifest_is_rejected_without_modification(self):
        self.initialize()
        for raw in (b"{", b"\xff", b"[]", b'{"schema_version":1,"schema_version":1}', b'{"value":NaN}'):
            with self.subTest(raw=raw):
                self.store.manifest_path.write_bytes(raw)
                with self.assertRaises(EvidenceError):
                    self.store.verify()
                self.assertEqual(self.store.manifest_path.read_bytes(), raw)

    def test_manifest_rejects_bad_types_and_missing_fields(self):
        self.initialize()
        self.record()
        original = self.manifest()
        mutators = (
            lambda item: item.update(schema_version=True),
            lambda item: item.update(revision=True),
            lambda item: item.update(revision=99),
            lambda item: item.update(records={}),
            lambda item: item.update(exclusions=None),
            lambda item: item.update(created_at="2026-09-18T00:00:00+04:00"),
            lambda item: item.update(catalogue_sha256="0" * 64),
            lambda item: item["records"][0].update(result="DONE"),
            lambda item: item["records"][0].update(record_id="invalid"),
            lambda item: item["records"][0].update(artifacts=[]),
            lambda item: item["records"][0].update(recorded_at="2026-02-30T00:00:00Z"),
            lambda item: item["records"][0]["artifacts"][0].update(path="../outside.txt"),
            lambda item: item["records"][0]["artifacts"][0].update(size_bytes=True),
            lambda item: item["records"][0]["artifacts"][0].update(sha256="invalid"),
            lambda item: item["records"][0].pop("phase"),
            lambda item: item.update(unexpected=True),
        )
        for mutate in mutators:
            with self.subTest(mutate=mutate):
                document = copy.deepcopy(original)
                mutate(document)
                self.write_manifest(document)
                with self.assertRaises(EvidenceError):
                    self.store.verify()

    def test_catalogue_changes_are_rejected_including_test_steps(self):
        self.initialize()
        for field, value in (("required", False), ("positive_steps", ["Changed synthetic steps."])):
            with self.subTest(field=field):
                changed = copy.deepcopy(self.catalogue)
                changed["scenarios"][0][field] = value
                self.catalogue_path.write_text(json.dumps(changed), encoding="utf-8")
                with self.assertRaisesRegex(EvidenceError, "Catalogue content changed"):
                    EvidenceStore(self.root, self.catalogue_path).report()
        self.assertTrue(EvidenceStore(self.root).verify()["valid"])

    def test_added_catalogue_case_is_not_silently_omitted(self):
        self.initialize()
        self.catalogue["scenarios"].append({"id": "NEW-01", "title": "New case", "required": True})
        self.write_catalogue()
        with self.assertRaisesRegex(EvidenceError, "changed"):
            EvidenceStore(self.root, self.catalogue_path).report()
        new_store = EvidenceStore(self.workspace / "new-evidence", self.catalogue_path)
        new_store.initialize()
        case = next(case for case in new_store.report()["scenarios"] if case["id"] == "NEW-01")
        self.assertEqual(case["status"], "NOT_RUN")

    def test_expected_revision_prevents_stale_updates(self):
        self.initialize()
        self.record(result="BLOCKED", artifacts=[], expected_revision=0)
        with self.assertRaisesRegex(EvidenceError, "revision"):
            self.record(result="BLOCKED", artifacts=[], expected_revision=0)
        with self.assertRaises(EvidenceError):
            self.store.exclude("A-01", "Synthetic reason.", "reviewer", "2026-09-18", -1)
        self.assertEqual(self.manifest()["revision"], 1)

    def test_lock_blocks_all_other_store_operations(self):
        self.initialize()
        other = EvidenceStore(self.root)
        with self.store._lock():
            for operation in (
                other.verify, other.report, self.store.initialize,
                lambda: other.record("A-01", "agent", "positive", "BLOCKED", "Synthetic reason.", "live_product"),
            ):
                with self.subTest(operation=operation):
                    with self.assertRaises(core.LockedError):
                        operation()
        self.assertFalse((self.root / core.LOCK_NAME).exists())
        self.assertTrue(other.verify()["valid"])

    def test_stale_lock_is_not_automatically_deleted(self):
        self.initialize()
        lock = self.root / core.LOCK_NAME
        lock.write_bytes(b"Synthetic stale lock.")
        with self.assertRaises(core.LockedError):
            self.store.verify()
        self.assertEqual(lock.read_bytes(), b"Synthetic stale lock.")

    @unittest.skipUnless(os.name == "nt", "Windows lock sharing test.")
    def test_windows_lock_creation_denial_is_explicit_and_retryable(self):
        self.initialize()
        original = self.store.manifest_path.read_bytes()
        with mock.patch.object(core.os, "open", side_effect=PermissionError("Synthetic lock sharing conflict")):
            with self.assertRaisesRegex(core.LockedError, "Cannot acquire the evidence lock"):
                self.store.verify()
        self.assertEqual(self.store.manifest_path.read_bytes(), original)
        self.assertFalse((self.root / core.LOCK_NAME).exists())
        self.assertTrue(self.store.verify()["valid"])

    def test_parallel_writers_have_no_lost_updates(self):
        self.initialize()
        failures = []
        barrier = threading.Barrier(8)

        def writer(number):
            barrier.wait(timeout=10)
            try:
                for _ in range(1000):
                    try:
                        EvidenceStore(self.root).record(
                            "A-01", "concurrent-test-set", "positive", "BLOCKED",
                            f"Synthetic concurrent result {number}.", "live_product",
                        )
                        return
                    except core.LockedError:
                        time.sleep(0.003)
                raise AssertionError("Writer could not acquire the lock.")
            except Exception as exc:
                failures.append(exc)

        threads = [threading.Thread(target=writer, args=(number,)) for number in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=20)
        self.assertFalse(any(thread.is_alive() for thread in threads))
        self.assertEqual(failures, [])
        manifest = self.manifest()
        self.assertEqual(manifest["revision"], 8)
        self.assertEqual(len({record["record_id"] for record in manifest["records"]}), 8)
        self.assertTrue(self.store.verify()["valid"])

    def test_agent_binding_serializes_competing_initial_agents(self):
        self.initialize()
        artifact = self.artifact()
        barrier = threading.Barrier(2)
        recorded, rejected, failures = [], [], []

        def writer(agent, phase):
            try:
                barrier.wait(timeout=10)
                for _ in range(1000):
                    try:
                        EvidenceStore(self.root).record(
                            "A-01", agent, phase, "PASS",
                            "Synthetic concurrent result.", "live_product", [artifact],
                        )
                        recorded.append(agent)
                        return
                    except core.LockedError:
                        time.sleep(0.003)
                    except EvidenceError as exc:
                        rejected.append(str(exc))
                        return
                raise AssertionError("Writer could not acquire the lock.")
            except Exception as exc:
                failures.append(exc)

        threads = [
            threading.Thread(target=writer, args=("agent-a", "positive")),
            threading.Thread(target=writer, args=("agent-b", "negative")),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=20)
        self.assertFalse(any(thread.is_alive() for thread in threads))
        self.assertEqual(failures, [])
        self.assertEqual(len(recorded), 1)
        self.assertEqual(len(rejected), 1)
        self.assertIn("bound to agent alias " + recorded[0], rejected[0])
        self.assertEqual(self.manifest()["revision"], 1)
        self.assertEqual(self.case()["status"], "NOT_RUN")
        self.assertTrue(self.store.verify()["valid"])

    def test_atomic_update_failure_preserves_old_manifest(self):
        self.initialize()
        original = self.store.manifest_path.read_bytes()
        with mock.patch.object(core.os, "replace", side_effect=OSError("Synthetic replacement failure")):
            with self.assertRaises(EvidenceError):
                self.record(result="BLOCKED", artifacts=[])
        self.assertEqual(self.store.manifest_path.read_bytes(), original)
        self.assertEqual([path.name for path in self.root.iterdir()], [core.MANIFEST_NAME])
        self.assertTrue(self.store.verify()["valid"])

    def test_noncooperative_manifest_change_is_detected_before_replacement(self):
        self.initialize()
        with self.store._lock():
            manifest, previous_hash = self.store._load()
            changed = self.store.manifest_path.read_bytes() + b" "
            self.store.manifest_path.write_bytes(changed)
            with self.assertRaisesRegex(EvidenceError, "Manifest changed"):
                self.store._write(manifest, previous_hash)
            self.assertEqual(self.store.manifest_path.read_bytes(), changed)

    def test_cli_end_to_end_and_acceptance_exit_codes(self):
        status, stdout, _ = self.cli(
            "init", "--evidence-dir", str(self.root), "--catalogue", str(self.catalogue_path), "--format", "json",
        )
        self.assertEqual(status, 0)
        self.assertTrue(json.loads(stdout)["initialized"])
        artifact = self.artifact()
        for scenario, kind in (("A-01", "live_product"), ("HARNESS-003", "local_simulation")):
            for phase in ("positive", "negative"):
                status, stdout, _ = self.cli(
                    "record", "--evidence-dir", str(self.root), "--scenario", scenario,
                    "--agent", "synthetic-agent", "--phase", phase, "--result", "PASS",
                    "--reason", "Synthetic result.", "--evidence-kind", kind, "--artifact", artifact,
                    "--format", "json",
                )
                self.assertEqual(status, 0, stdout)
        status, stdout, _ = self.cli("report", "--evidence-dir", str(self.root), "--format", "json")
        self.assertEqual(status, 0)
        self.assertTrue(json.loads(stdout)["acceptance"]["achieved"])
        status, stdout, _ = self.cli("verify", "--evidence-dir", str(self.root))
        self.assertEqual(status, 0)
        self.assertIn("Product behavior is not verified", stdout)

    def test_cli_reports_no_live_results_with_required_denominators(self):
        self.initialize()
        self.pass_scenario("HARNESS-003", "local_simulation")
        status, stdout, _ = self.cli("report", "--evidence-dir", str(self.root))
        self.assertEqual(status, 1)
        self.assertIn("No live product result exists.", stdout)
        self.assertIn("Required scenarios: 1/2 PASS.", stdout)
        self.assertIn("Layer identity: NOT_RUN", stdout)
        self.assertIn("local_simulation:", stdout)
        self.assertIn("Optional scenarios: 0/1 PASS.", stdout)

    def test_cli_exclusion_does_not_make_product_pass_or_success_exit(self):
        self.initialize()
        self.pass_scenario("HARNESS-003", "local_simulation")
        status, stdout, _ = self.cli(
            "record", "--evidence-dir", str(self.root), "--scenario", "A-01",
            "--exclude", "--reason", "Product access is unavailable.",
            "--approved-by", "reviewer", "--approved-date", "2026-09-18",
        )
        self.assertEqual(status, 0)
        self.assertIn("No product pass was created", stdout)
        status, stdout, _ = self.cli("report", "--evidence-dir", str(self.root), "--format", "json")
        self.assertEqual(status, 1)
        self.assertTrue(json.loads(stdout)["acceptance"]["agreed_required"]["achieved"])

    def test_cli_requires_explicit_kind_and_rejects_mixed_exclusion_fields(self):
        self.initialize()
        prefix = [
            "record", "--evidence-dir", str(self.root), "--scenario", "A-01",
            "--reason", "Synthetic reason.", "--format", "json",
        ]
        for suffix in (
            ["--agent", "agent", "--phase", "positive", "--result", "BLOCKED"],
            ["--exclude"],
            ["--approved-by", "reviewer"],
            ["--exclude", "--agent", "agent", "--approved-by", "reviewer", "--approved-date", "2026-09-18"],
            ["--exclude", "--result", "PASS", "--approved-by", "reviewer", "--approved-date", "2026-09-18"],
        ):
            with self.subTest(suffix=suffix):
                status, stdout, _ = self.cli(*(prefix + suffix))
                self.assertEqual(status, 2)
                self.assertFalse(json.loads(stdout)["acceptance_achieved"])
        self.assertEqual(self.manifest()["revision"], 0)

    def test_cli_integrity_error_never_emits_a_pass_report(self):
        self.initialize()
        self.record()
        (self.root / "artifacts" / "A-01-positive-live_product.txt").write_bytes(b"Tampered synthetic data.")
        for command in ("report", "verify"):
            with self.subTest(command=command):
                status, stdout, stderr = self.cli(command, "--evidence-dir", str(self.root), "--format", "json")
                self.assertEqual(status, 2)
                self.assertEqual(stderr, "")
                self.assertFalse(json.loads(stdout)["acceptance_achieved"])
                self.assertIn("integrity", json.loads(stdout)["error"])

    def test_cli_requires_explicit_evidence_dir(self):
        with self.assertRaises(SystemExit) as caught:
            self.cli("verify")
        self.assertEqual(caught.exception.code, 2)

    def test_cli_agent_binding_error_preserves_manifest(self):
        self.initialize()
        self.record(agent="agent-a")
        original = self.store.manifest_path.read_bytes()
        status, stdout, stderr = self.cli(
            "record", "--evidence-dir", str(self.root), "--scenario", "A-01",
            "--agent", "agent-b", "--phase", "negative", "--result", "PASS",
            "--reason", "Synthetic result.", "--evidence-kind", "live_product",
            "--artifact", "not-created.txt", "--format", "json",
        )
        self.assertEqual(status, 2)
        self.assertEqual(stderr, "")
        self.assertIn("bound to agent alias agent-a", json.loads(stdout)["error"])
        self.assertFalse(json.loads(stdout)["acceptance_achieved"])
        self.assertEqual(self.store.manifest_path.read_bytes(), original)

    def test_cli_help_lists_all_commands(self):
        stdout = io.StringIO()
        with redirect_stdout(stdout), self.assertRaises(SystemExit) as caught:
            main(["--help"])
        self.assertEqual(caught.exception.code, 0)
        for command in ("init", "record", "report", "verify"):
            self.assertIn(command, stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
