"""Application-only read guard. This is not Microsoft policy enforcement."""

import hashlib
import json
import os
from pathlib import Path
import stat
from .safety import bounded_text

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"
HASHES = {
    "public-procedure.txt": "bd45fc0e6163d863af19ac05dfea27734af660210294877c2524742d3d3722f4",
    "restricted-record.txt": "bbd3384276bdb4ea9c086de27f3e8790b05e2a5307c3b2e7493e5182f15c9ea2",
    "untrusted-instruction.txt": "d97b1d4e882dc5cb51c71e0f28a3b12a67fd0288ef1fe61e7ed103ac3f05cc27",
}
# Accept the same checked-in synthetic text on LF and CRLF checkouts.
MAX_FIXTURE_BYTES = 8192
TOOL_SCHEMA = [{
    "type": "function",
    "function": {
        "name": "read_fixture",
        "description": "Read a bundled synthetic test fixture. The application denies the restricted record.",
        "parameters": {
            "type": "object",
            "properties": {"name": {"type": "string", "enum": list(HASHES)}},
            "required": ["name"],
            "additionalProperties": False,
        },
    },
}]


def denied(reason):
    return {"allowed": False, "reason": reason}


def _reparse(info):
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 1024)
    )


def read_fixture(name):
    if not isinstance(name, str) or name not in HASHES:
        return denied("invalid_fixture")
    if name == "restricted-record.txt":
        return denied("application_policy")
    try:
        # Reject directory junctions and links, not just a linked leaf.
        if any(_reparse(parent.lstat()) for parent in (FIXTURES, *FIXTURES.parents)):
            return denied("unsafe_fixture")
        path = FIXTURES / name
        before = path.lstat()
        if (_reparse(before) or not stat.S_ISREG(before.st_mode)
                or before.st_size > MAX_FIXTURE_BYTES
                or path.resolve().parent != FIXTURES.resolve()):
            return denied("unsafe_fixture")
        with path.open("rb") as stream:
            opened = os.fstat(stream.fileno())
            if (_reparse(opened) or not stat.S_ISREG(opened.st_mode)
                    or opened.st_size > MAX_FIXTURE_BYTES
                    or (opened.st_ino, opened.st_dev) != (before.st_ino, before.st_dev)):
                return denied("unsafe_fixture")
            raw = stream.read(MAX_FIXTURE_BYTES + 1)
        if len(raw) > MAX_FIXTURE_BYTES:
            return denied("oversize_fixture")
        normalized = raw.replace(b"\r\n", b"\n")
        if hashlib.sha256(normalized).hexdigest() != HASHES[name]:
            return denied("fixture_integrity")
        return {"allowed": True, "synthetic": True, "untrusted_data": normalized.decode("utf-8")}
    except (OSError, UnicodeError, ValueError):
        return denied("unavailable_fixture")


def dispatch(name, arguments):
    if name != "read_fixture":
        return denied("unknown_tool")
    if not bounded_text(arguments, 1024):
        return denied("invalid_arguments")
    try:
        obj = json.loads(arguments)
    except (ValueError, UnicodeError, RecursionError):
        return denied("invalid_arguments")
    if not isinstance(obj, dict) or set(obj) != {"name"}:
        return denied("invalid_arguments")
    return read_fixture(obj["name"])
