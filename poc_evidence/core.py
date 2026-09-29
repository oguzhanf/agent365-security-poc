"""Standard-library evidence storage. Artifact contents are never copied."""

import copy
import hashlib
import json
import math
import os
import re
import stat
import uuid
from contextlib import contextmanager
from datetime import date, datetime, timezone
from pathlib import Path, PureWindowsPath


REPOSITORY_ROOT = Path(__file__).resolve().parent.parent
MANIFEST_NAME = "manifest.json"
LOCK_NAME = ".poc-evidence.lock"
STATUSES = ("NOT_RUN", "PASS", "FAIL", "BLOCKED", "NOT_APPLICABLE")
PHASES = ("positive", "negative", "control")
KINDS = ("live_product", "local_simulation")
ID_PATTERN = re.compile(r"[A-Z][A-Z0-9]*-[0-9]{2,3}\Z")
ALIAS_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z")
SHA_PATTERN = re.compile(r"[0-9a-f]{64}\Z")
UTC_PATTERN = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z\Z")
MAX_JSON_BYTES = 16 * 1024 * 1024


class EvidenceError(Exception):
    """An explicit input, storage, integrity, or concurrency failure."""


class LockedError(EvidenceError):
    """Another operation holds the evidence lock."""


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _text(value, label, maximum=4096):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise EvidenceError(f"{label} must be a nonempty string of at most {maximum} characters.")
    if "\x00" in value:
        raise EvidenceError(f"{label} must not contain a null character.")
    try:
        value.encode("utf-8")
    except UnicodeError as exc:
        raise EvidenceError(f"{label} must be valid UTF-8 text.") from exc
    return value


def _alias(value, label):
    if not isinstance(value, str) or not ALIAS_PATTERN.fullmatch(value):
        raise EvidenceError(f"{label} must be a 1-64 character alias using letters, digits, _, . or -.")
    return value


def _bind_agent(bindings, scenario_id, evidence_kind, agent_id):
    key = (
        _scenario_id(scenario_id),
        _choice(evidence_kind, KINDS, "Evidence kind"),
    )
    _alias(agent_id, "Agent id")
    if key in bindings and bindings[key] != agent_id:
        raise EvidenceError(
            f"Scenario {scenario_id} ({evidence_kind}) is bound to agent alias {bindings[key]}. "
            "Use a new evidence store for another agent."
        )
    bindings[key] = agent_id


def _scenario_id(value):
    if not isinstance(value, str) or not ID_PATTERN.fullmatch(value):
        raise EvidenceError("Scenario id must match ^[A-Z][A-Z0-9]*-[0-9]{2,3}$.")
    return value


def _utc(value, label):
    if not isinstance(value, str) or not UTC_PATTERN.fullmatch(value):
        raise EvidenceError(f"{label} must be a UTC timestamp ending in Z.")
    try:
        return datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as exc:
        raise EvidenceError(f"{label} is not a valid UTC timestamp.") from exc


def _date(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise EvidenceError("Approval date must be a UTC calendar date: YYYY-MM-DD.")
    try:
        date.fromisoformat(value)
    except ValueError as exc:
        raise EvidenceError("Approval date is not valid.") from exc
    return value


def _integer(value, label, minimum=0):
    if type(value) is not int or value < minimum:
        raise EvidenceError(f"{label} must be an integer of at least {minimum}.")
    return value


def _choice(value, choices, label):
    if not isinstance(value, str) or value not in choices:
        raise EvidenceError(f"{label} must be one of: {', '.join(choices)}.")
    return value


def _keys(value, required, optional, label):
    if not isinstance(value, dict):
        raise EvidenceError(f"{label} must be an object.")
    missing = set(required) - value.keys()
    extra = value.keys() - set(required) - set(optional)
    if missing or extra:
        raise EvidenceError(
            f"{label} has invalid fields. Missing: {', '.join(sorted(missing)) or 'none'}. "
            f"Unknown: {', '.join(sorted(extra)) or 'none'}."
        )


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise EvidenceError("JSON contains a duplicate object key.")
        result[key] = value
    return result


def _constant(_value):
    raise EvidenceError("JSON must not contain NaN or Infinity.")


def _float(value):
    result = float(value)
    if not math.isfinite(result):
        raise EvidenceError("JSON numbers must be finite.")
    return result


def _decode(raw, label):
    if len(raw) > MAX_JSON_BYTES:
        raise EvidenceError(f"{label} exceeds the 16 MiB limit.")
    try:
        return json.loads(
            raw.decode("utf-8"), object_pairs_hook=_pairs,
            parse_constant=_constant, parse_float=_float,
        )
    except (UnicodeError, ValueError, RecursionError) as exc:
        raise EvidenceError(f"{label} is not valid UTF-8 JSON.") from exc


def _encode(value):
    try:
        return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n").encode("utf-8")
    except (UnicodeError, ValueError, RecursionError) as exc:
        raise EvidenceError("Data cannot be encoded as finite UTF-8 JSON.") from exc


def _digest(value):
    return hashlib.sha256(_encode(value)).hexdigest()


def load_catalogue(path):
    """Return only acceptance metadata. Do not copy prompts or setup text."""
    try:
        with Path(path).open("rb") as stream:
            raw = stream.read(MAX_JSON_BYTES + 1)
    except (OSError, ValueError) as exc:
        raise EvidenceError(f"Cannot read catalogue: {exc}.") from exc
    document = _decode(raw, "Catalogue")
    if not isinstance(document, dict):
        raise EvidenceError("Catalogue must be an object.")
    if type(document.get("schema_version")) is not int or document["schema_version"] != 1:
        raise EvidenceError("Catalogue schema_version must be 1.")
    scenarios = document.get("scenarios")
    if not isinstance(scenarios, list) or not scenarios:
        raise EvidenceError("Catalogue scenarios must be a nonempty array.")
    normalized = []
    seen = set()
    for scenario in scenarios:
        if not isinstance(scenario, dict):
            raise EvidenceError("Each scenario must be an object.")
        scenario_id = _scenario_id(scenario.get("id"))
        if scenario_id in seen:
            raise EvidenceError(f"Duplicate scenario id: {scenario_id}.")
        seen.add(scenario_id)
        if type(scenario.get("required")) is not bool:
            raise EvidenceError(f"{scenario_id}: required must be a Boolean.")
        normalized.append({
            "id": scenario_id,
            "title": _text(scenario.get("title"), "Scenario title"),
            "required": scenario["required"],
            "layer": _text(scenario.get("layer", "unspecified"), "Scenario layer", 128),
            "validation_kind": _choice(scenario.get("validation_kind", "live_product"), KINDS, "Validation kind"),
        })
    return {
        "schema_version": 1, "source_sha256": _digest(document),
        "scenarios": sorted(normalized, key=lambda item: item["id"]),
    }


def _is_link(info):
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    )


def _within(path, root):
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _artifact_name(value):
    _text(value, "Artifact path", 2048)
    windows = PureWindowsPath(value)
    if windows.drive or windows.root or value.startswith(("/", "\\")):
        raise EvidenceError("Artifact paths must be relative to the evidence root.")
    parts = value.replace("\\", "/").split("/")
    for part in parts:
        if not part or part in (".", "..") or part.rstrip(" .") != part:
            raise EvidenceError("Artifact paths must not contain empty, dot, or parent segments.")
        if any(character in part for character in '<>:"|?*') or any(ord(character) < 32 for character in part):
            raise EvidenceError("Artifact path contains an unsafe character.")
        base = part.split(".")[0].upper()
        if base in {"CON", "PRN", "AUX", "NUL"} or re.fullmatch(r"(COM|LPT)[0-9¹²³]", base):
            raise EvidenceError("Artifact path contains a reserved device name.")
    if parts[0].casefold() in {MANIFEST_NAME.casefold(), LOCK_NAME.casefold()} or parts[0].casefold().startswith(".poc-evidence-"):
        raise EvidenceError("An internal evidence-store file cannot be an artifact.")
    return "/".join(parts)


def _signature(info):
    # Windows can expose different ctime semantics through stat and fstat.
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)


class EvidenceStore:
    def __init__(self, evidence_dir, catalogue_path=None):
        if not evidence_dir:
            raise EvidenceError("An explicit evidence directory is required.")
        requested = Path(evidence_dir)
        if not requested.is_absolute():
            raise EvidenceError("Evidence directory must be an absolute path outside the repository.")
        try:
            try:
                requested_info = requested.lstat()
            except FileNotFoundError:
                requested_info = None
            if requested_info is not None and _is_link(requested_info):
                raise EvidenceError("Evidence root must not be a symlink or reparse point.")
            self.root = requested.resolve()
        except (OSError, RuntimeError, ValueError) as exc:
            raise EvidenceError(f"Cannot resolve evidence directory: {exc}.") from exc
        if _within(self.root, REPOSITORY_ROOT.resolve()):
            raise EvidenceError("Evidence directory must be outside the source repository.")
        self.catalogue = load_catalogue(catalogue_path) if catalogue_path is not None else None
        self.manifest_path = self.root / MANIFEST_NAME

    def _check_root(self):
        try:
            info = self.root.lstat()
            if _is_link(info) or not stat.S_ISDIR(info.st_mode) or self.root.resolve() != self.root:
                raise EvidenceError("Evidence root is not a stable regular directory.")
        except OSError as exc:
            raise EvidenceError(f"Cannot access evidence directory: {exc}.") from exc

    @contextmanager
    def _lock(self):
        self._check_root()
        lock_path = self.root / LOCK_NAME
        descriptor = None
        identity = None
        try:
            try:
                descriptor = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError as exc:
                raise LockedError("Evidence store is locked. Retry after the other operation ends.") from exc
            except PermissionError as exc:
                if os.name != "nt":
                    raise
                # Windows can deny exclusive creation while a deleted lock is still closing.
                raise LockedError(
                    "Cannot acquire the evidence lock. Retry after other operations end or check directory permissions."
                ) from exc
            identity = os.fstat(descriptor)
            payload = _encode({"pid": os.getpid(), "acquired_at": utc_now()})
            with os.fdopen(descriptor, "wb") as stream:
                descriptor = None
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            yield
        except OSError as exc:
            raise EvidenceError(f"Evidence store operation failed: {exc}.") from exc
        finally:
            if descriptor is not None:
                os.close(descriptor)
            if identity is not None:
                try:
                    current = lock_path.lstat()
                    if not _is_link(current) and (current.st_dev, current.st_ino) == (identity.st_dev, identity.st_ino):
                        lock_path.unlink()
                except FileNotFoundError:
                    pass

    def _file_info(self, relative):
        self._check_root()
        path = self.root
        parts = relative.split("/")
        try:
            for index, part in enumerate(parts):
                path = path / part
                info = path.lstat()
                if _is_link(info):
                    raise EvidenceError(f"Symlinks and reparse points are not permitted: {relative}.")
                if index < len(parts) - 1 and not stat.S_ISDIR(info.st_mode):
                    raise EvidenceError(f"Artifact parent is not a directory: {relative}.")
            if not stat.S_ISREG(info.st_mode):
                raise EvidenceError(f"Evidence path is not a regular file: {relative}.")
            if not _within(path.resolve(), self.root):
                raise EvidenceError(f"Evidence path escapes the evidence root: {relative}.")
            return path, info
        except (OSError, RuntimeError) as exc:
            raise EvidenceError(f"Cannot access evidence file {relative}: {exc}.") from exc

    def _read_file(self, relative, keep_bytes=False):
        path, before = self._file_info(relative)
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        digest = hashlib.sha256()
        chunks = []
        size = 0
        try:
            with os.fdopen(os.open(path, flags), "rb") as stream:
                opened = os.fstat(stream.fileno())
                if _signature(opened) != _signature(before):
                    raise EvidenceError(f"Evidence file changed before reading: {relative}.")
                self._file_info(relative)
                while True:
                    chunk = stream.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if keep_bytes and size > MAX_JSON_BYTES:
                        raise EvidenceError("Manifest exceeds the 16 MiB limit.")
                    digest.update(chunk)
                    if keep_bytes:
                        chunks.append(chunk)
                after = os.fstat(stream.fileno())
            _, final = self._file_info(relative)
        except OSError as exc:
            raise EvidenceError(f"Cannot read evidence file {relative}: {exc}.") from exc
        if (
            _signature(before) != _signature(after) or _signature(before) != _signature(final)
            or before.st_ctime_ns != final.st_ctime_ns or opened.st_ctime_ns != after.st_ctime_ns
            or size != before.st_size
        ):
            raise EvidenceError(f"Evidence file changed during reading: {relative}.")
        return {"path": relative, "sha256": digest.hexdigest(), "size_bytes": size}, b"".join(chunks)

    def _validate_manifest(self, manifest):
        _keys(manifest, {
            "schema_version", "created_at", "updated_at", "revision", "catalogue",
            "catalogue_sha256", "records", "exclusions",
        }, set(), "Manifest")
        if type(manifest["schema_version"]) is not int or manifest["schema_version"] != 1:
            raise EvidenceError("Manifest schema_version must be 1.")
        created = _utc(manifest["created_at"], "Creation time")
        updated = _utc(manifest["updated_at"], "Update time")
        if updated < created:
            raise EvidenceError("Manifest update time precedes creation time.")
        _integer(manifest["revision"], "Revision")
        catalogue = manifest["catalogue"]
        _keys(catalogue, {"schema_version", "source_sha256", "scenarios"}, set(), "Stored catalogue")
        if type(catalogue["schema_version"]) is not int or catalogue["schema_version"] != 1:
            raise EvidenceError("Stored catalogue schema_version must be 1.")
        if not isinstance(catalogue["source_sha256"], str) or not SHA_PATTERN.fullmatch(catalogue["source_sha256"]):
            raise EvidenceError("Source catalogue sha256 must be 64 lowercase hexadecimal characters.")
        if not isinstance(catalogue["scenarios"], list) or not catalogue["scenarios"]:
            raise EvidenceError("Stored catalogue scenarios must be a nonempty array.")
        scenarios = {}
        for scenario in catalogue["scenarios"]:
            _keys(scenario, {"id", "title", "required", "layer", "validation_kind"}, set(), "Stored scenario")
            scenario_id = _scenario_id(scenario["id"])
            if scenario_id in scenarios:
                raise EvidenceError(f"Duplicate stored scenario: {scenario_id}.")
            _text(scenario["title"], "Scenario title")
            _text(scenario["layer"], "Scenario layer", 128)
            if type(scenario["required"]) is not bool:
                raise EvidenceError("Stored required flag must be a Boolean.")
            _choice(scenario["validation_kind"], KINDS, "Validation kind")
            scenarios[scenario_id] = scenario
        if not isinstance(manifest["catalogue_sha256"], str) or manifest["catalogue_sha256"] != _digest(catalogue):
            raise EvidenceError("Stored catalogue hash does not match.")
        if self.catalogue is not None and self.catalogue != catalogue:
            raise EvidenceError("Catalogue content changed. Initialize a new evidence directory.")
        if not isinstance(manifest["records"], list) or not isinstance(manifest["exclusions"], list):
            raise EvidenceError("Records and exclusions must be arrays.")
        if manifest["revision"] != len(manifest["records"]) + len(manifest["exclusions"]):
            raise EvidenceError("Manifest revision does not match its history.")
        record_ids = set()
        agent_bindings = {}
        for record in manifest["records"]:
            _keys(record, {
                "record_id", "recorded_at", "scenario_id", "agent_id", "phase",
                "result", "reason", "evidence_kind", "artifacts",
            }, {"correlation_id"}, "Evidence record")
            record_id = record["record_id"]
            try:
                valid_uuid = isinstance(record_id, str) and str(uuid.UUID(record_id)) == record_id
            except ValueError:
                valid_uuid = False
            if not valid_uuid or record_id in record_ids:
                raise EvidenceError("Record id must be a unique canonical UUID.")
            record_ids.add(record_id)
            recorded = _utc(record["recorded_at"], "Record time")
            if not created <= recorded <= updated:
                raise EvidenceError("Record time is outside the manifest time range.")
            if _scenario_id(record["scenario_id"]) not in scenarios:
                raise EvidenceError("Record refers to an unknown scenario.")
            _bind_agent(agent_bindings, record["scenario_id"], record["evidence_kind"], record["agent_id"])
            _choice(record["phase"], PHASES, "Test phase")
            _choice(record["result"], STATUSES, "Result")
            _text(record["reason"], "Reason")
            if "correlation_id" in record:
                _text(record["correlation_id"], "Correlation id", 128)
            if not isinstance(record["artifacts"], list):
                raise EvidenceError("Record artifacts must be an array.")
            paths = set()
            nonempty = False
            for artifact in record["artifacts"]:
                _keys(artifact, {"path", "sha256", "size_bytes"}, set(), "Artifact")
                relative = _artifact_name(artifact["path"])
                if relative != artifact["path"] or relative.casefold() in paths:
                    raise EvidenceError("Artifact paths must be canonical and unique in a record.")
                paths.add(relative.casefold())
                if not isinstance(artifact["sha256"], str) or not SHA_PATTERN.fullmatch(artifact["sha256"]):
                    raise EvidenceError("Artifact sha256 must be 64 lowercase hexadecimal characters.")
                nonempty = _integer(artifact["size_bytes"], "Artifact size") > 0 or nonempty
            if record["result"] == "PASS" and not nonempty:
                raise EvidenceError("PASS requires at least one existing nonempty artifact.")
        excluded = set()
        for exclusion in manifest["exclusions"]:
            _keys(exclusion, {"scenario_id", "reason", "approved_by", "approved_date", "recorded_at"}, set(), "Exclusion")
            scenario_id = _scenario_id(exclusion["scenario_id"])
            if scenario_id not in scenarios or scenario_id in excluded:
                raise EvidenceError("Exclusion scenario must exist and must not already be excluded.")
            excluded.add(scenario_id)
            _text(exclusion["reason"], "Exclusion reason")
            _alias(exclusion["approved_by"], "Approver")
            _date(exclusion["approved_date"])
            recorded = _utc(exclusion["recorded_at"], "Exclusion record time")
            if not created <= recorded <= updated:
                raise EvidenceError("Exclusion time is outside the manifest time range.")

    def _load(self):
        info, raw = self._read_file(MANIFEST_NAME, keep_bytes=True)
        manifest = _decode(raw, "Manifest")
        self._validate_manifest(manifest)
        return manifest, info["sha256"]

    def _verify_artifacts(self, manifest):
        count = 0
        for record in manifest["records"]:
            for artifact in record["artifacts"]:
                current, _ = self._read_file(artifact["path"])
                if current != artifact:
                    raise EvidenceError(f"Artifact integrity check failed: {artifact['path']}.")
                count += 1
        return count

    def _write(self, manifest, previous_hash=None):
        self._validate_manifest(manifest)
        self._check_root()
        data = _encode(manifest)
        if len(data) > MAX_JSON_BYTES:
            raise EvidenceError("Manifest exceeds the 16 MiB limit.")
        temporary = self.root / (".poc-evidence-" + uuid.uuid4().hex + ".tmp")
        try:
            with temporary.open("xb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            if previous_hash is None:
                # Hard-link publication fails if any file already uses this name.
                os.link(temporary, self.manifest_path)
            else:
                current, _ = self._read_file(MANIFEST_NAME)
                if current["sha256"] != previous_hash:
                    raise EvidenceError("Manifest changed during this operation. No update was applied.")
                os.replace(temporary, self.manifest_path)
            if os.name != "nt":
                descriptor = os.open(self.root, os.O_RDONLY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
        finally:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass

    def initialize(self):
        if self.catalogue is None:
            raise EvidenceError("Initialization requires --catalogue.")
        try:
            self.root.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise EvidenceError(f"Cannot create evidence directory: {exc}.") from exc
        with self._lock():
            if any(path.name != LOCK_NAME for path in self.root.iterdir()):
                raise EvidenceError("Evidence directory is not empty. Existing evidence was not changed.")
            now = utc_now()
            manifest = {
                "schema_version": 1, "created_at": now, "updated_at": now, "revision": 0,
                "catalogue": copy.deepcopy(self.catalogue), "catalogue_sha256": _digest(self.catalogue),
                "records": [], "exclusions": [],
            }
            self._write(manifest)
            return copy.deepcopy(manifest)

    def _prepare_update(self, expected_revision):
        manifest, previous_hash = self._load()
        if expected_revision is not None:
            _integer(expected_revision, "Expected revision")
            if manifest["revision"] != expected_revision:
                raise EvidenceError("Expected revision does not match. No update was applied.")
        self._verify_artifacts(manifest)
        return manifest, previous_hash

    def record(self, scenario_id, agent_id, phase, result, reason, evidence_kind,
               artifacts=(), correlation_id=None, expected_revision=None):
        with self._lock():
            manifest, previous_hash = self._prepare_update(expected_revision)
            agent_bindings = {
                (record["scenario_id"], record["evidence_kind"]): record["agent_id"]
                for record in manifest["records"]
            }
            _bind_agent(agent_bindings, scenario_id, evidence_kind, agent_id)
            now = utc_now()
            record = {
                "record_id": str(uuid.uuid4()), "recorded_at": now,
                "scenario_id": scenario_id, "agent_id": agent_id, "phase": phase,
                "result": result, "reason": reason, "evidence_kind": evidence_kind, "artifacts": [],
            }
            if correlation_id is not None:
                record["correlation_id"] = correlation_id
            if isinstance(artifacts, (str, bytes)) or not isinstance(artifacts, (list, tuple)):
                raise EvidenceError("Artifacts must be a list or tuple of relative paths.")
            for path in artifacts:
                artifact, _ = self._read_file(_artifact_name(path))
                record["artifacts"].append(artifact)
            manifest["records"].append(record)
            manifest["revision"] += 1
            manifest["updated_at"] = now
            self._validate_manifest(manifest)
            # Recheck old and new artifacts immediately before publication.
            self._verify_artifacts(manifest)
            self._write(manifest, previous_hash)
            return copy.deepcopy(record)

    def exclude(self, scenario_id, reason, approved_by, approved_date, expected_revision=None):
        with self._lock():
            manifest, previous_hash = self._prepare_update(expected_revision)
            now = utc_now()
            exclusion = {
                "scenario_id": scenario_id, "reason": reason, "approved_by": approved_by,
                "approved_date": approved_date, "recorded_at": now,
            }
            manifest["exclusions"].append(exclusion)
            manifest["revision"] += 1
            manifest["updated_at"] = now
            self._write(manifest, previous_hash)
            return copy.deepcopy(exclusion)

    def verify(self):
        with self._lock():
            manifest, _ = self._load()
            artifact_count = self._verify_artifacts(manifest)
            return {
                "valid": True, "revision": manifest["revision"],
                "records": len(manifest["records"]), "artifact_references": artifact_count,
                "scope": "Local manifest and artifact integrity only. Product behavior is not verified.",
            }

    def report(self):
        with self._lock():
            manifest, _ = self._load()
            artifact_count = self._verify_artifacts(manifest)
            return _report(manifest, artifact_count)


def _aggregate(statuses):
    statuses = list(statuses)
    if not statuses:
        return None
    for candidate in ("FAIL", "BLOCKED", "NOT_APPLICABLE", "NOT_RUN"):
        if candidate in statuses:
            return candidate
    return "PASS"


def _phase_status(records):
    latest = {}
    for record in records:
        latest[record["phase"]] = record
    phases = {phase: latest[phase]["result"] if phase in latest else "NOT_RUN" for phase in PHASES}
    relevant = [phases["positive"], phases["negative"]]
    if "control" in latest and phases["control"] != "NOT_RUN":
        relevant.append(phases["control"])
    return _aggregate(relevant), phases, {phase: record["record_id"] for phase, record in latest.items()}


def _summary(cases):
    counts = {status: sum(case["status"] == status for case in cases) for status in STATUSES}
    denominator = len(cases)
    return {
        "passed": counts["PASS"], "denominator": denominator, "status_counts": counts,
        "status": _aggregate(case["status"] for case in cases),
        "achieved": denominator > 0 and counts["PASS"] == denominator,
    }


def _report(manifest, artifact_count):
    exclusions = {item["scenario_id"]: item for item in manifest["exclusions"]}
    cases = []
    for scenario in manifest["catalogue"]["scenarios"]:
        related = [item for item in manifest["records"] if item["scenario_id"] == scenario["id"]]
        kinds = {}
        for kind in KINDS:
            status, phases, record_ids = _phase_status([item for item in related if item["evidence_kind"] == kind])
            kinds[kind] = {"status": status, "phases": phases, "latest_record_ids": record_ids}
        case = dict(scenario)
        case.update({
            "status": kinds[scenario["validation_kind"]]["status"],
            "evidence": kinds, "exclusion": exclusions.get(scenario["id"]),
        })
        cases.append(case)
    required = [case for case in cases if case["required"]]
    optional = [case for case in cases if not case["required"]]
    agreed = [case for case in required if case["exclusion"] is None]
    by_kind = {}
    for kind in KINDS:
        subset = [case for case in cases if case["validation_kind"] == kind]
        records = [item for item in manifest["records"] if item["evidence_kind"] == kind]
        by_kind[kind] = {
            "scenario_count": len(subset), "record_count": len(records),
            "result_record_count": sum(
                item["result"] in ("PASS", "FAIL") and any(artifact["size_bytes"] > 0 for artifact in item["artifacts"])
                for item in records
            ),
            "required": _summary([case for case in subset if case["required"]]),
            "optional": _summary([case for case in subset if not case["required"]]),
        }
    layers = {}
    for layer in sorted({case["layer"] for case in cases}):
        subset = [case for case in cases if case["layer"] == layer]
        layer_required = [case for case in subset if case["required"]]
        layers[layer] = {
            "status": _aggregate(case["status"] for case in layer_required),
            "required": _summary(layer_required),
            "agreed_required": _summary([case for case in layer_required if case["exclusion"] is None]),
            "optional": _summary([case for case in subset if not case["required"]]),
        }
    required_summary = _summary(required)
    return {
        "schema_version": 1, "generated_at": utc_now(), "revision": manifest["revision"],
        "integrity": {"valid": True, "records": len(manifest["records"]), "artifact_references": artifact_count},
        "notice": (
            "No live product result exists." if by_kind["live_product"]["result_record_count"] == 0
            else "Live product evidence is recorded. Local verification does not verify product behavior."
        ),
        "acceptance": {
            "achieved": required_summary["achieved"], "required": required_summary,
            "agreed_required": _summary(agreed), "optional": _summary(optional),
            "excluded_required": len(required) - len(agreed), "excluded_total": len(exclusions),
        },
        "by_evidence_kind": by_kind, "layers": layers, "scenarios": cases,
    }


def report_text(report):
    acceptance = report["acceptance"]
    required = acceptance["required"]
    agreed = acceptance["agreed_required"]
    optional = acceptance["optional"]
    lines = [
        report["notice"],
        "Local manifest and artifact integrity: valid. Product behavior is not verified by this tool.",
        "Catalogue acceptance: " + ("ACHIEVED." if acceptance["achieved"] else "NOT ACHIEVED."),
        f"Required scenarios: {required['passed']}/{required['denominator']} PASS.",
        f"Agreed required scenarios: {agreed['passed']}/{agreed['denominator']} PASS; "
        + ("ACHIEVED." if agreed["achieved"] else "NOT ACHIEVED."),
        f"Excluded required scenarios: {acceptance['excluded_required']}. Exclusions are not passes.",
        f"Optional scenarios: {optional['passed']}/{optional['denominator']} PASS. Optional cases do not change acceptance.",
    ]
    for kind in KINDS:
        group = report["by_evidence_kind"][kind]
        summary = group["required"]
        lines.append(
            f"{kind}: {group['record_count']} records; {group['result_record_count']} result records; "
            f"{summary['passed']}/{summary['denominator']} required PASS."
        )
    for layer, values in report["layers"].items():
        summary = values["required"]
        lines.append(f"Layer {layer}: {values['status'] or 'NO_REQUIRED_CASES'}; {summary['passed']}/{summary['denominator']} required PASS.")
    for case in report["scenarios"]:
        selected = case["evidence"][case["validation_kind"]]
        label = "required" if case["required"] else "optional"
        lines.append(
            f"{case['id']}: {case['status']}; {label}; {case['validation_kind']}; "
            f"positive={selected['phases']['positive']}; negative={selected['phases']['negative']}."
        )
        if case["exclusion"]:
            exclusion = case["exclusion"]
            lines.append(
                f"  Excluded by {exclusion['approved_by']} on {exclusion['approved_date']} UTC: {exclusion['reason']}"
            )
    return "\n".join(lines)
