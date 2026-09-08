"""Regression checks for a live iPad process whose WebView is still blank."""
import importlib.util
import io
import json
import subprocess
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "ios_simulator_smoke", Path(__file__).with_name("ios-simulator-smoke.py")
)
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class RuntimeSelectionTests(unittest.TestCase):
    def setUp(self):
        self.info = {"CFBundleSupportedPlatforms": ["iPhoneSimulator"], "MinimumOSVersion": "14.0"}
        self.ios18 = "com.apple.CoreSimulator.SimRuntime.iOS-18-6"
        self.ios26 = "com.apple.CoreSimulator.SimRuntime.iOS-26-2"
        self.inventory = {self.ios18: [{"name": "iPhone 16"}]}

    def test_local_accepts_compatible_runtime_without_weakening_ci(self):
        self.assertEqual(smoke.select_runtime(self.inventory, self.info, local=True)[0], self.ios18)
        with self.assertRaisesRegex(RuntimeError, "iOS 26"):
            smoke.select_runtime(self.inventory, self.info)

    def test_latest_compatible_ios_is_selected(self):
        self.inventory[self.ios26] = [{"name": "iPhone 17"}]
        self.inventory["com.apple.CoreSimulator.SimRuntime.tvOS-27-0"] = [{"name": "Apple TV"}]
        self.inventory["com.apple.CoreSimulator.SimRuntime.iOS-27-0"] = []
        for local in (False, True):
            self.assertEqual(smoke.select_runtime(self.inventory, self.info, local)[0], self.ios26)

    def test_runtime_must_meet_the_built_apps_minimum_version(self):
        self.info["MinimumOSVersion"] = "18.6.1"
        with self.assertRaisesRegex(RuntimeError, "18.6.1"):
            smoke.select_runtime(self.inventory, self.info, local=True)

    def test_device_build_and_unknown_minimum_are_rejected(self):
        for info in ({**self.info, "CFBundleSupportedPlatforms": ["iPhoneOS"]},
                     {**self.info, "MinimumOSVersion": "unknown"}):
            with self.assertRaises(RuntimeError):
                smoke.select_runtime(self.inventory, info, local=True)

    def test_local_opt_in_cannot_relax_ci_requirements(self):
        for environment, options in (({}, []), ({"CI": "true"}, ["--local"])):
            with patch.dict(smoke.os.environ, environment, clear=True), \
                    patch.object(smoke.sys, "argv", ["smoke", "App.app", "--output", "output", *options]), \
                    patch.object(smoke.sys, "stderr", io.StringIO()), \
                    patch.object(smoke, "simctl") as command:
                with self.assertRaises(SystemExit) as raised:
                    smoke.main()
                self.assertEqual(raised.exception.code, 2)
                command.assert_not_called()

    def test_boot_wait_cannot_be_unbounded_or_negative(self):
        for timeout in ("0", "-1", "1801"):
            with patch.object(smoke.sys, "argv", ["smoke", "App.app", "--output", "output", "--boot-timeout", timeout]), \
                    patch.object(smoke.sys, "stderr", io.StringIO()), \
                    patch.object(smoke, "simctl") as command:
                with self.assertRaises(SystemExit) as raised:
                    smoke.main()
                self.assertEqual(raised.exception.code, 2)
                command.assert_not_called()

    def test_previous_evidence_is_preserved_and_cannot_count_as_a_new_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = root / "App.app"
            app.mkdir()
            (app / "Info.plist").write_bytes(b"not-read")
            output = root / "evidence"
            output.mkdir()
            previous = output / "launch-report.json"
            previous.write_text("previous successful run")
            with patch.dict(smoke.os.environ, {}, clear=True), \
                    patch.object(smoke.sys, "argv", ["smoke", str(app), "--local", "--output", str(output)]), \
                    patch.object(smoke.sys, "stderr", io.StringIO()), \
                    patch.object(smoke, "simctl") as command:
                with self.assertRaises(SystemExit) as raised:
                    smoke.main()
                self.assertEqual(raised.exception.code, 2)
                self.assertEqual(previous.read_text(), "previous successful run")
                command.assert_not_called()


class FrontendVisibilityTests(unittest.TestCase):
    def test_status_bar_and_spinner_are_not_a_ready_app(self):
        self.assertFalse(smoke.frontend_is_visible(["1:54 PM", "Sat Sep 5", "100% "]))
        self.assertFalse(smoke.frontend_is_visible([]))

    def test_partial_page_without_add_action_is_not_ready(self):
        self.assertFalse(smoke.frontend_is_visible(["我的連線", "還沒有任何連線"]))
        self.assertFalse(smoke.frontend_is_visible(["Connections", "Add connection"]))

    def test_traditional_chinese_page_is_visible(self):
        self.assertTrue(smoke.frontend_is_visible([
            "我的連線", "還沒有任何連線", "+ 新增連線", "載入範例",
        ]))

    def test_english_page_is_visible(self):
        self.assertTrue(smoke.frontend_is_visible([
            "Connections", "No connections yet", "+ Add connection", "Load samples",
        ]))

    def test_ocr_spacing_does_not_hide_present_controls(self):
        self.assertTrue(smoke.frontend_is_visible(["還 沒有 任 何 連線", "新 增 連 線"]))


class StoreScreenshotTests(unittest.TestCase):
    def test_store_model_does_not_take_the_first_narrow_phone(self):
        devices = [{"name": name, "deviceTypeIdentifier": name} for name in (
            "iPhone 17 Pro", "iPhone 16 Pro Max", "iPhone 17 Pro Max",
        )]
        self.assertEqual(smoke.store_model(devices, "iPhone")["name"], "iPhone 17 Pro Max")

    def test_store_model_requires_a_supported_phone_and_large_ipad(self):
        devices = [{"name": name, "deviceTypeIdentifier": name} for name in (
            "iPhone 17 Pro", "iPad Pro 11-inch (M5)", "iPad Pro 13-inch (M5)",
        )]
        with self.assertRaises(RuntimeError):
            smoke.store_model(devices, "iPhone")
        self.assertEqual(smoke.store_model(devices, "iPad")["name"], "iPad Pro 13-inch (M5)")

    def test_only_native_store_sizes_without_alpha_are_accepted(self):
        def metadata(width, height, alpha="no", format="jpeg"):
            return f"/tmp/capture.jpg\n  pixelWidth: {width}\n  pixelHeight: {height}\n  hasAlpha: {alpha}\n  format: {format}\n"
        self.assertEqual(smoke.store_image_metadata(metadata(1320, 2868), "iPhone")["width"], 1320)
        self.assertEqual(smoke.store_image_metadata(metadata(2064, 2752), "iPad")["height"], 2752)
        for text in (metadata(1206, 2622), metadata(1320, 2868, "yes"), metadata(1320, 2868, format="png"), "missing"):
            with self.assertRaises(RuntimeError):
                smoke.store_image_metadata(text, "iPhone")


class FailureEvidenceTests(unittest.TestCase):
    def test_ocr_timeout_retries_a_fresh_capture_without_extending_deadline(self):
        now = [0.0]
        attempts = []

        def recognize(*args, **kwargs):
            attempts.append(kwargs["timeout"])
            if len(attempts) == 1:
                now[0] += kwargs["timeout"]
                raise subprocess.TimeoutExpired(args, kwargs["timeout"])
            now[0] += 2
            return subprocess.CompletedProcess(args, 0, stdout='["No connections yet", "Add connection"]')

        with patch.object(smoke.time, "monotonic", side_effect=lambda: now[0]), \
                patch.object(smoke.os, "kill"), \
                patch.object(smoke, "simctl") as capture, \
                patch.object(smoke.subprocess, "run", side_effect=recognize):
            result = smoke.wait_for_frontend("owned-device", 123, Path("capture.png"), Path("reader"))
        self.assertTrue(result["renderedStartup"])
        self.assertEqual(result["renderWaitSeconds"], 47)
        self.assertEqual(capture.call_count, 2)
        self.assertEqual(attempts, [45, 45])

    def test_persistent_ocr_timeouts_fail_at_the_original_deadline(self):
        now = [0.0]
        attempts = []

        def recognize(*args, **kwargs):
            attempts.append(kwargs["timeout"])
            now[0] += kwargs["timeout"]
            raise subprocess.TimeoutExpired(args, kwargs["timeout"])

        with patch.object(smoke.time, "monotonic", side_effect=lambda: now[0]), \
                patch.object(smoke.os, "kill"), \
                patch.object(smoke, "simctl"), \
                patch.object(smoke.subprocess, "run", side_effect=recognize):
            with self.assertRaises(subprocess.TimeoutExpired):
                smoke.wait_for_frontend("owned-device", 123, Path("capture.png"), Path("reader"), timeout=70)
        self.assertEqual(now[0], 70)
        self.assertEqual(attempts, [45, 25])

    def test_success_checks_and_cleans_only_new_devices_and_saves_both_results(self):
        commands = []
        boot_waits = []
        owned = iter(("new-phone", "new-tablet"))

        def simctl(*args, **kwargs):
            commands.append(args)
            if args[0] == "bootstatus":
                boot_waits.append(kwargs["timeout"])
            if args[0] == "create":
                return next(owned)
            if args[0] == "launch":
                return f"{smoke.BUNDLE_ID}: 123"
            return ""

        with tempfile.TemporaryDirectory() as directory, \
                patch.object(smoke, "simctl", side_effect=simctl), \
                patch.object(smoke, "wait_for_frontend", return_value={"renderedStartup": True}) as frontend:
            output = Path(directory)
            args = Namespace(app=output / "App.app", output=output, store_screenshots=False, boot_timeout=600)
            devices = [{"name": name, "deviceTypeIdentifier": name} for name in ("iPhone 16", "iPad Pro")]
            smoke.check_simulators(args, "runtime", devices, output / "reader")
            report = json.loads((output / "launch-report.json").read_text())
            self.assertEqual([entry["family"] for entry in report], ["iPhone", "iPad"])
            self.assertTrue(all(entry["renderedStartup"] for entry in report))
            self.assertEqual([call.args[0] for call in frontend.call_args_list], ["new-phone", "new-tablet"])
            self.assertEqual(boot_waits, [600, 600])
            self.assertTrue(all("timeout" not in call.kwargs for call in frontend.call_args_list))
        for command in commands:
            if command[0] != "create":
                self.assertIn(command[1], ("new-phone", "new-tablet"))
        self.assertEqual([command for command in commands if command[0] in ("shutdown", "delete")], [
            ("shutdown", "new-phone"), ("delete", "new-phone"),
            ("shutdown", "new-tablet"), ("delete", "new-tablet"),
        ])

    def test_slow_capture_can_finish_within_the_shared_readiness_deadline(self):
        now = [100.0]

        def capture(*args, **kwargs):
            if kwargs["timeout"] < 25:
                raise subprocess.TimeoutExpired(args, kwargs["timeout"])
            now[0] += 25
            return ""

        def recognize(*args, **kwargs):
            self.assertLessEqual(kwargs["timeout"], 90 - (now[0] - 100))
            now[0] += 2
            return subprocess.CompletedProcess(args, 0, stdout='["還沒有任何連線", "新增連線"]')

        with patch.object(smoke.time, "monotonic", side_effect=lambda: now[0]), \
                patch.object(smoke.os, "kill"), \
                patch.object(smoke, "simctl", side_effect=capture), \
                patch.object(smoke.subprocess, "run", side_effect=recognize):
            result = smoke.wait_for_frontend("owned-device", 123, Path("capture.png"), Path("reader"))
        self.assertTrue(result["renderedStartup"])
        self.assertEqual(result["renderWaitSeconds"], 27)

    def test_launch_timeout_is_preserved_when_capture_also_fails(self):
        commands = []
        original = subprocess.TimeoutExpired(["xcrun", "simctl", "launch"], 330)

        def simctl(*args, **kwargs):
            commands.append((args, kwargs))
            if args[0] == "create":
                return "owned-device"
            if args[0] == "launch":
                raise original
            if args[0] == "io":
                raise RuntimeError("simulator unavailable")
            return ""

        with tempfile.TemporaryDirectory() as directory, patch.object(smoke, "simctl", side_effect=simctl):
            output = Path(directory)
            args = Namespace(app=output / "App.app", output=output, store_screenshots=False, boot_timeout=180)
            devices = [{"name": name, "deviceTypeIdentifier": name} for name in ("iPhone", "iPad")]
            with self.assertRaises(subprocess.TimeoutExpired) as raised:
                smoke.check_simulators(args, "runtime", devices, output / "reader")
            self.assertIs(raised.exception, original)
            report = json.loads((output / "iPhone.failure.json").read_text())
            self.assertEqual(report["stage"], "launch")
            self.assertEqual(report["errorType"], "TimeoutExpired")
            self.assertIn("simulator unavailable", report["captureError"])
            self.assertFalse((output / "launch-report.json").exists())
        self.assertEqual(commands[-2][0], ("shutdown", "owned-device"))
        self.assertEqual(commands[-1][0], ("delete", "owned-device"))
        self.assertEqual(next(kwargs["timeout"] for args, kwargs in commands if args[0] == "io"), 15)
        self.assertFalse(any(args[0] == "create" and "iPad" in args[1] for args, _ in commands))


if __name__ == "__main__":
    unittest.main()
