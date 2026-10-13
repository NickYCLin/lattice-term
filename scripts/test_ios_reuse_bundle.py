import hashlib
import importlib.util
import json
import platform
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("reuse", Path(__file__).with_name("ios-reuse-bundle.py"))
reuse = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reuse)


class ProvenanceTests(unittest.TestCase):
    def test_requires_source_digest_architecture_and_unsigned_provenance(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            archive = directory / "ios-simulator.tar.gz"
            archive.write_bytes(b"fixture")
            valid = {"commit": "a" * 40, "runId": "123", "signedForDeviceInstallation": False,
                     "simulatorArchitecture": platform.machine(),
                     "sha256": {archive.name: hashlib.sha256(b"fixture").hexdigest()}}
            for invalid in ({}, {"commit": "b" * 40}, {"runId": "456"},
                            {"simulatorArchitecture": "wrong"}, {"signedForDeviceInstallation": True},
                            {"sha256": {archive.name: "wrong"}}):
                (directory / "provenance.json").write_text(json.dumps({**valid, **invalid}))
                if invalid:
                    with self.assertRaises(RuntimeError):
                        reuse.verify_bundle(directory, "123", "a" * 40)
                else:
                    self.assertEqual(reuse.verify_bundle(directory, "123", "a" * 40), archive)


if __name__ == "__main__":
    unittest.main()
