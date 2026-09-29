"""Run explicitly inside the locked venv; standard-library discovery skips this."""

import os
from pathlib import Path
import subprocess
import sys
import unittest


class InstalledSdkTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get("POC_RUN_SDK_TESTS") == "1", "Opt-in installed SDK integration check")
    def test_installed_sdk_offline_in_fresh_process(self):
        root = Path(__file__).resolve().parents[2]
        result = subprocess.run(
            [sys.executable, str(root / "tests" / "runtime" / "sdk_offline_check.py")],
            cwd=root, capture_output=True, text=True, timeout=60, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('"network_blocked": true', result.stdout)
        self.assertIn('"export_called": false', result.stdout)


if __name__ == "__main__":
    unittest.main()
