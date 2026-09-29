import contextlib
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

SMOKE = Path(__file__).with_name("sdk_import_check.py")


def load_smoke():
    spec = importlib.util.spec_from_file_location("foundry_sdk_import_smoke", SMOKE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ImportSmokeTests(unittest.TestCase):
    def test_module_import_does_not_import_sdk_or_install_guard(self):
        before = set(sys.modules)
        with patch.object(sys, "addaudithook") as add_hook:
            smoke = load_smoke()
        add_hook.assert_not_called()
        added = set(sys.modules) - before
        self.assertFalse(any(name.startswith(("azure.", "agent_framework", "microsoft.opentelemetry"))
                             for name in added))
        self.assertTrue(callable(smoke.main))

    def test_guard_precedes_sdk_import_and_stays_enabled(self):
        smoke = load_smoke()
        calls = []
        def check_imports():
            self.assertEqual(calls, ["guard"])
            self.assertEqual(os.environ["MICROSOFT_OTEL_SDKSTATS_DISABLED"], "true")
            self.assertEqual(os.environ["APPLICATIONINSIGHTS_STATSBEAT_DISABLED_ALL"], "true")
            self.assertEqual(os.environ["ENABLE_INSTRUMENTATION"], "false")
            self.assertEqual(os.environ["OTEL_SDK_DISABLED"], "true")
            calls.append("imports")
        with patch.dict(os.environ, {}, clear=True), \
             patch.object(smoke, "install_network_guard", side_effect=lambda: calls.append("guard")), \
             patch.object(smoke, "check_sdk_imports", side_effect=check_imports), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            smoke.main()
        self.assertEqual(calls, ["guard", "imports"])
        self.assertIn("No provider, credential, exporter, app", output.getvalue())

    def test_socket_and_dns_are_denied_in_dedicated_process(self):
        command = """
import importlib.util, socket, _socket, sys
spec = importlib.util.spec_from_file_location("guard_test", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.install_network_guard()
checks = [
    socket.socket,
    _socket.socket,
    lambda: socket.getaddrinfo("unit.invalid", 443),
    lambda: socket.gethostbyname("unit.invalid"),
    lambda: socket.gethostbyaddr("192.0.2.1"),
    lambda: socket.getnameinfo(("192.0.2.1", 443), 0),
    lambda: socket.create_connection(("unit.invalid", 443)),
]
for check in checks:
    try:
        check()
    except module.NetworkAccessBlocked:
        continue
    raise AssertionError("A socket or DNS operation was not blocked.")
print("All socket/DNS guards passed.")
"""
        result = subprocess.run([sys.executable, "-B", "-c", command, str(SMOKE)],
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("All socket/DNS guards passed.", result.stdout)


if __name__ == "__main__":
    unittest.main()
