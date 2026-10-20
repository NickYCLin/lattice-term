import importlib.util
import os
import plistlib
from subprocess import run as run_command
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("verify_ios_app", Path(__file__).with_name("verify-ios-app.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BundleVerificationTests(unittest.TestCase):
    def test_sqlite_linkage_is_platform_scoped(self):
        manifest = Path(__file__).resolve().parent.parent / "src-tauri/Cargo.toml"
        cargo = tomllib.loads(manifest.read_text(encoding="utf-8"))
        self.assertNotIn("sqlite", cargo["dependencies"]["sqlx"]["features"])
        self.assertNotIn("sqlite-unbundled", cargo["dependencies"]["sqlx"]["features"])
        self.assertIn("sqlite", cargo["target"]['cfg(not(target_os = "ios"))']["dependencies"]["sqlx"]["features"])
        ios = cargo["target"]['cfg(target_os = "ios")']["dependencies"]
        self.assertEqual(ios["rusqlite"]["features"], ["modern_sqlite"])
        self.assertFalse(ios["rusqlite"]["default-features"])
        apple = manifest.parent / "gen/apple"
        self.assertIn("- sdk: libsqlite3.tbd", (apple / "project.yml").read_text(encoding="utf-8"))
        project = (apple / "lattice-term.xcodeproj/project.pbxproj").read_text(encoding="utf-8")
        self.assertIn("path = usr/lib/libsqlite3.tbd; sourceTree = SDKROOT;", project)
        self.assertEqual(project.count("/* libsqlite3.tbd in Frameworks */"), 2)
        wrapper = Path(__file__).with_name("ios-sqlite-build.sh").read_text(encoding="utf-8")
        self.assertIn("export LIBSQLITE3_SYS_USE_PKG_CONFIG=1", wrapper)
        self.assertIn("export SQLITE3_STATIC=0", wrapper)

    @unittest.skipIf(os.name == "nt", "Xcode SDK wrapper runs on macOS")
    def test_sqlite_build_uses_selected_sdk_and_preserves_arguments(self):
        script = Path(__file__).with_name("ios-sqlite-build.sh")
        sdk = Path(self.directory.name) / "Selected SDK"
        (sdk / "usr/include").mkdir(parents=True)
        (sdk / "usr/include/sqlite3.h").write_text("test header")
        environment = {**os.environ, "SDKROOT": str(sdk), "BINDGEN_EXTRA_CLANG_ARGS": "-DTEST=1"}
        command = ['sh', str(script), 'sh', '-c', 'printf "%s\\n" "$SQLITE3_INCLUDE_DIR" "$SQLITE3_LIB_DIR" "$BINDGEN_EXTRA_CLANG_ARGS" "$1"', 'test', 'argument with spaces']
        result = run_command(command, env=environment, text=True, capture_output=True, check=True)
        self.assertEqual(result.stdout.splitlines(), [str(sdk / "usr/include"), str(sdk / "usr/lib"), '-DTEST=1', 'argument with spaces'])
        environment["SDKROOT"] = str(sdk / "missing")
        self.assertNotEqual(run_command(command, env=environment, capture_output=True).returncode, 0)

    def setUp(self):
        self.nm = patch.object(module.subprocess, "run").start()
        self.addCleanup(patch.stopall)
        self.nm.return_value.stdout = "_stat\n_fstat\n_mach_absolute_time\n"
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.app = Path(self.directory.name) / "LatticeTerm.app"
        self.app.mkdir()
        self.info = {
            "CFBundleIdentifier": "io.github.nickyclin.latticeterm",
            "CFBundleShortVersionString": "0.45.0",
            "CFBundleVersion": "2",
            "CFBundleExecutable": "LatticeTerm",
            "DTSDKName": "iphoneos26.0",
            "NSLocalNetworkUsageDescription": "Connect to a selected host",
            "UIFileSharingEnabled": True,
            "LSSupportsOpeningDocumentsInPlace": True,
        }
        self.write_info()
        (self.app / "LatticeTerm").write_bytes(b"test fixture")
        source = Path(__file__).resolve().parent.parent / "src-tauri/gen/apple/lattice-term_iOS/PrivacyInfo.xcprivacy"
        (self.app / "PrivacyInfo.xcprivacy").write_bytes(source.read_bytes())

    def write_info(self):
        (self.app / "Info.plist").write_bytes(plistlib.dumps(self.info))

    def test_store_bundle_metadata(self):
        self.assertEqual(module.verify(self.app, "0.45.0", "2", True)["buildNumber"], "2")

    def test_rejects_old_sdk_and_simulator_for_store(self):
        for sdk in ("iphoneos18.5", "iphonesimulator26.0"):
            self.info["DTSDKName"] = sdk
            self.write_info()
            with self.assertRaises(ValueError):
                module.verify(self.app, "0.45.0", require_store_sdk=True)

    def test_rejects_missing_bundled_privacy_manifest(self):
        (self.app / "PrivacyInfo.xcprivacy").unlink()
        with self.assertRaises(FileNotFoundError):
            module.verify(self.app, "0.45.0")

    def test_rejects_wrong_version_or_build(self):
        with self.assertRaises(ValueError):
            module.verify(self.app, "0.46.0", "2")
        with self.assertRaises(ValueError):
            module.verify(self.app, "0.45.0", "3")

    def test_rejects_desktop_sidecar(self):
        (self.app / "lattice-rdp-engine").write_bytes(b"test fixture")
        with self.assertRaises(ValueError):
            module.verify(self.app, "0.45.0")

    def test_rejects_bundles_without_files_access_to_exports(self):
        for key in ("UIFileSharingEnabled", "LSSupportsOpeningDocumentsInPlace"):
            self.info[key] = False
            self.write_info()
            with self.assertRaisesRegex(ValueError, key):
                module.verify(self.app, "0.45.0")
            self.info[key] = True

    def test_reports_undeclared_imports_in_simulator_without_claiming_readiness(self):
        self.nm.return_value.stdout += "_fstatvfs\n"
        result = module.verify(self.app, "0.45.0", check_api_symbols=True)
        self.assertEqual(result["privacyAPIReview"]["status"], "needs_review")
        self.assertEqual(result["privacyAPIReview"]["missingManifestCategories"], ["NSPrivacyAccessedAPICategoryDiskSpace"])
        self.assertEqual(self.nm.call_args.args[0], ["xcrun", "nm", "-u", "-j", str(self.app / "LatticeTerm")])

    def test_rejects_undeclared_imports_for_store(self):
        self.nm.return_value.stdout += "_fstatfs\n"
        with self.assertRaisesRegex(ValueError, "DiskSpace"):
            module.verify(self.app, "0.45.0", require_store_sdk=True)

    def test_symbol_inspection_failures_are_not_reported_as_success(self):
        self.nm.side_effect = module.subprocess.CalledProcessError(1, "nm")
        with self.assertRaises(module.subprocess.CalledProcessError):
            module.verify(self.app, "0.45.0", check_api_symbols=True)

    def test_strict_api_check_also_applies_to_release_simulator(self):
        self.info["DTSDKName"] = "iphonesimulator26.0"
        self.write_info()
        self.assertEqual(module.verify(self.app, "0.45.0", require_declared_api=True)["privacyAPIReview"]["status"], "declared_c_imports")
        self.nm.return_value.stdout += "_statvfs\n"
        with self.assertRaisesRegex(ValueError, "DiskSpace"):
            module.verify(self.app, "0.45.0", require_declared_api=True)


if __name__ == "__main__":
    unittest.main()
