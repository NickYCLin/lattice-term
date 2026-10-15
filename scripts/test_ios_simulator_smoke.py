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
    def test_keyboard_scroll_bounds_convert_dom_coordinates_without_relaxing_visibility(self):
        snapshot = {"windowBounds": {"width": 402, "height": 874},
                    "webviewInWindow": {"x": 0, "y": 0}, "scrollBounds": {"y": 233.6666667}, "dom": {
            "innerWidth": 402, "innerHeight": 874, "viewport": {"height": 471, "offsetTop": 233.65625},
            "rects": [{"selector": ".app--mobile", "y": -0.34375, "height": 471},
                      {"selector": ".drawer__foot", "y": 404.65625, "height": 61},
                      {"selector": ".drawer__body", "y": 120, "height": 284.65625},
                      {"selector": ".drawer input", "x": 20, "y": 244, "width": 362, "height": 42},
                      {"selector": ".drawer__head button", "x": 336, "y": 70, "width": 46, "height": 46}]}}
        controls = [{"frame": {"x": 20, "y": 244, "width": 362, "height": 42}},
                    {"frame": {"x": 336, "y": 70, "width": 46, "height": 46}}]
        smoke.validate_native_viewport(snapshot, keyboard=True, keyboard_frame={"y": 583, "height": 233}, controls=controls)
        snapshot["dom"]["rects"][2]["height"] = 150
        with self.assertRaisesRegex(RuntimeError, "底列遮擋"):
            smoke.validate_native_viewport(snapshot, keyboard=True, controls=controls)
        snapshot["dom"]["rects"][2]["height"] = 284.65625
        controls[0]["frame"]["y"] = 300
        with self.assertRaisesRegex(RuntimeError, "座標不符"):
            smoke.validate_native_viewport(snapshot, keyboard=True, controls=controls)
        controls[0]["frame"]["y"] = 900
        with self.assertRaisesRegex(RuntimeError, "超出視窗"):
            smoke.validate_native_viewport(snapshot, keyboard=True, controls=controls)
        with self.assertRaisesRegex(RuntimeError, "缺少鍵盤"):
            smoke.validate_native_viewport(snapshot, keyboard=True, controls=[])
        snapshot["dom"]["rects"][1]["y"] = 450
        with self.assertRaisesRegex(RuntimeError, "控制列超出"):
            smoke.validate_native_viewport(snapshot, keyboard=True)
        snapshot["scrollBounds"]["y"] = 0
        with self.assertRaisesRegex(RuntimeError, "App 起點"):
            smoke.validate_native_viewport(snapshot, keyboard=True)

    def test_interaction_failures_preserve_errors_and_continue_other_devices(self):
        owned = iter(("new-phone", "new-tablet"))

        def simctl(*args, **kwargs):
            return next(owned) if args[0] == "create" else ""

        with tempfile.TemporaryDirectory() as directory, \
                patch.object(smoke, "simctl", side_effect=simctl) as command, \
                patch.object(smoke, "prepare_ci_keyboard", side_effect=RuntimeError("keyboard setup failed")), \
                patch.object(smoke, "capture_failure") as capture:
            root = Path(directory)
            args = Namespace(app=root / "App.app", output=root, store_screenshots=False,
                             boot_timeout=600, interaction_checks=True)
            devices = [{"name": name, "deviceTypeIdentifier": name} for name in ("iPhone", "iPad")]
            with self.assertRaisesRegex(RuntimeError, "iPhone, iPad"):
                smoke.check_simulators(args, "runtime", devices, root / "reader")
            self.assertEqual(capture.call_count, 2)
            failures = json.loads((root / "interaction-failures.json").read_text())
            self.assertEqual([failure["device"] for failure in failures], ["iPhone", "iPad"])
            self.assertTrue(all(failure["stage"] == "keyboard-setup" for failure in failures))
            self.assertEqual([call.args for call in command.call_args_list if call.args[0] == "delete"],
                             [("delete", "new-phone"), ("delete", "new-tablet")])

    def test_keyboard_setup_targets_only_ci_disposable_device(self):
        with patch.dict(smoke.os.environ, {"CI": "true"}), \
                patch.object(smoke.subprocess, "run") as run:
            smoke.prepare_ci_keyboard("owned-device")
            self.assertEqual(run.call_count, 2)
            self.assertIn("owned-device", run.call_args_list[0].args[0])
            self.assertIn("<false/>", run.call_args_list[0].args[0][-1])
            self.assertEqual(run.call_args_list[1].args[0], [
                "open", "-a", "Simulator", "--args", "-CurrentDeviceUDID",
                "owned-device", "-ConnectHardwareKeyboard", "NO"])
        with patch.dict(smoke.os.environ, {"CI": "false"}), \
                patch.object(smoke.subprocess, "run") as run:
            smoke.prepare_ci_keyboard("owned-device")
            run.assert_not_called()

    def test_keyboard_geometry_must_not_overlap_native_keyboard(self):
        snapshot = {"windowBounds": {"width": 402, "height": 874}, "webviewInWindow": {"y": 0}, "dom": {
            "innerWidth": 402, "innerHeight": 874, "viewport": {"height": 500, "offsetTop": 0},
            "rects": [{"selector": ".app--mobile", "y": 0, "height": 500}]}}
        smoke.validate_native_viewport(snapshot, keyboard=True, keyboard_frame={"y": 500, "height": 374})
        with self.assertRaisesRegex(RuntimeError, "鍵盤重疊"):
            smoke.validate_native_viewport(snapshot, keyboard=True, keyboard_frame={"y": 490, "height": 384})
        with self.assertRaisesRegex(RuntimeError, "鍵盤重疊"):
            smoke.validate_native_viewport(snapshot, keyboard=True, keyboard_frame={"y": 500, "height": 0})

    def test_process_evidence_rejects_recursive_launches_and_ignores_other_devices(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            executable = output / "owned device" / "LatticeTerm.app" / "LatticeTerm"
            for extra, expected_count in [("", 1), (f"101 100 {executable}\n", 2)]:
                process_output = f"100 1 {executable}\n200 1 /other/device/LatticeTerm.app/LatticeTerm\n" + extra
                with patch.object(smoke, "simctl", return_value=str(executable.parent)), \
                        patch.object(smoke.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, process_output, "")):
                    if extra:
                        with self.assertRaisesRegex(RuntimeError, "單一程序"):
                            smoke.capture_app_processes("owned-device", 100, output, "phone", "baseline")
                    else:
                        smoke.capture_app_processes("owned-device", 100, output, "phone", "baseline")
                evidence = json.loads((output / "phone.baseline.processes.json").read_text())
                self.assertEqual(len(evidence["processes"]), expected_count)

    def test_full_viewport_rejects_safe_area_sized_dom_and_clipped_controls(self):
        snapshot = {"windowBounds": {"width": 402, "height": 874}, "dom": {
            "innerWidth": 402, "innerHeight": 874, "viewport": {"height": 874, "offsetTop": 0},
            "rects": [{"selector": ".app--mobile", "y": 0, "height": 874}]}}
        smoke.validate_native_viewport(snapshot)
        snapshot["dom"]["innerHeight"] = 778
        with self.assertRaisesRegex(RuntimeError, "DOM 仍短於原生"):
            smoke.validate_native_viewport(snapshot)
        snapshot["dom"]["innerHeight"] = 874
        snapshot["dom"]["viewport"]["height"] = 500
        snapshot["dom"]["rects"][0]["height"] = 500
        smoke.validate_native_viewport(snapshot, keyboard=True)
        snapshot["dom"]["rects"].append({"selector": ".drawer__foot", "y": 490, "height": 50})
        with self.assertRaisesRegex(RuntimeError, "控制列超出"):
            smoke.validate_native_viewport(snapshot, keyboard=True)

    def test_interactions_require_all_stages_and_fresh_geometry(self):
        stages = ["keyboard-open", "keyboard-closed", "landscape", "portrait-return"]
        observations = [{"stage": stage, "capturedAt": 100 + index * 10, "captureFinishedAt": 101 + index * 10, "captureStableUntil": 106 + index * 10,
                         "keyboardVisible": stage == "keyboard-open", "keyboardFrame": {"y": 500, "height": 300},
                         "controls": [{"hittable": True, "frame": {"y": 100, "width": 44, "height": 44}}]}
                        for index, stage in enumerate(stages)]
        stdout = "\n".join("LATTICE_LAYOUT_STAGE " + json.dumps(entry) for entry in observations)
        snapshots = [{"capturedAt": entry["capturedAt"] + 1.2, "dom": {
            "capturedAt": entry["capturedAt"] + 1.2, "innerHeight": 400,
            "rects": [{"selector": ".app--mobile", "height": 400}]}} for entry in observations]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(smoke.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout, "")), \
                    patch.object(smoke, "read_layout_snapshots", return_value=snapshots), \
                    patch.object(smoke, "validate_native_viewport") as validate:
                smoke.capture_interactions("owned-device", root, root, "phone", (root, root))
                self.assertEqual(validate.call_count, 4)
            result = json.loads((root / "phone.interactions.json").read_text())
            self.assertEqual([entry["stage"] for entry in result], stages)
            self.assertEqual(result[-1]["layout"]["capturedAt"], 131.2)
            for invalid in ({"capturedAt": 100, "dom": {"capturedAt": 80, "rects": [{"selector": ".app--mobile", "height": 400}]}},
                            {"capturedAt": 100, "dom": {"capturedAt": 100, "rects": []}},
                            {"capturedAt": 106.1, "dom": {"capturedAt": 106.1, "rects": [{"selector": ".app--mobile", "height": 400}]}}):
                with patch.object(smoke.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout, "")), \
                        patch.object(smoke, "read_layout_snapshots", return_value=[invalid]):
                    with self.assertRaisesRegex(RuntimeError, "新鮮"):
                        smoke.capture_interactions("owned-device", root, root, "invalid", (root, root))
            with patch.object(smoke.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout, "")), \
                    patch.object(smoke, "read_layout_snapshots", return_value=[{"capturedAt": 1}]):
                with self.assertRaisesRegex(RuntimeError, "新鮮"):
                    smoke.capture_interactions("owned-device", root, root, "stale", (root, root))

    def test_interactions_preserve_geometry_when_native_test_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(smoke.subprocess, "run", return_value=subprocess.CompletedProcess([], 65, "native failure", "")), \
                    patch.object(smoke, "read_layout_snapshots", return_value=[{"capturedAt": 100}]):
                with self.assertRaisesRegex(RuntimeError, "驗收失敗"):
                    smoke.capture_interactions("owned-device", root, root, "phone", (root, root))
            self.assertEqual((root / "phone.interactions.log").read_text(), "native failure")
            self.assertEqual(json.loads((root / "phone.interaction-layout.json").read_text()), [{"capturedAt": 100}])

    def test_interactions_reject_incorrect_keyboard_state_and_hidden_controls(self):
        stages = ["keyboard-open", "keyboard-closed", "landscape", "portrait-return"]
        for fault, message in [("keyboard", "鍵盤狀態"), ("controls", "無法點擊"), ("overlap", "鍵盤遮擋")]:
            observations = [{"stage": stage, "capturedAt": 100 + index * 10, "captureFinishedAt": 101 + index * 10,
                             "keyboardVisible": stage == "keyboard-open", "keyboardFrame": {"y": 500},
                             "controls": [{"hittable": True, "frame": {"y": 100, "width": 44, "height": 44}}]}
                            for index, stage in enumerate(stages)]
            if fault == "keyboard":
                observations[0]["keyboardVisible"] = False
            elif fault == "controls":
                observations[0]["controls"][0]["hittable"] = False
            else:
                observations[0]["controls"][0]["frame"]["y"] = 490
            stdout = "\n".join("LATTICE_LAYOUT_STAGE " + json.dumps(entry) for entry in observations)
            snapshots = [{"capturedAt": entry["capturedAt"] - 2, "dom": {
                "capturedAt": entry["capturedAt"] - 2,
                "rects": [{"selector": ".app--mobile", "height": 400}]}} for entry in observations]
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                with patch.object(smoke.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout, "")), \
                        patch.object(smoke, "read_layout_snapshots", return_value=snapshots), \
                        patch.object(smoke, "validate_native_viewport"):
                    with self.assertRaisesRegex(RuntimeError, message):
                        smoke.capture_interactions("owned-device", root, root, fault, (root, root))

    def test_interactions_preserve_partial_output_on_timeout(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(smoke.subprocess, "run", side_effect=subprocess.TimeoutExpired("xcodebuild", 300, b"partial output", b"stderr")), \
                    patch.object(smoke, "read_layout_snapshots", return_value=[{"capturedAt": 100}]):
                with self.assertRaisesRegex(RuntimeError, "驗收失敗"):
                    smoke.capture_interactions("owned-device", root, root, "phone", (root, root))
            self.assertIn("partial outputstderr", (root / "phone.interactions.log").read_text())
            self.assertIn("timed out", (root / "phone.interactions.log").read_text())
            self.assertTrue((root / "phone.interaction-layout.json").is_file())

    def test_viewport_comparisons_wait_for_each_variant_and_preserve_originals(self):
        now = [100.0]
        captures = []
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / "cache"
            cache.mkdir()
            original = root / "phone.png"
            original.write_bytes(b"original")

            def snapshots(*args, **kwargs):
                variant = (cache / "layout-variant.txt").read_text()
                return [{"variant": variant, "capturedAt": now[0]}]

            def sleep(seconds):
                now[0] += seconds

            with patch.object(smoke.time, "time", side_effect=lambda: now[0]), \
                    patch.object(smoke.time, "monotonic", side_effect=lambda: now[0]), \
                    patch.object(smoke.time, "sleep", side_effect=sleep), \
                    patch.object(smoke, "read_layout_snapshots", side_effect=snapshots), \
                    patch.object(smoke, "simctl", side_effect=lambda *args, **kwargs: captures.append(args)):
                results = smoke.capture_viewport_experiments("owned-device", cache, root, "phone")
            self.assertEqual([entry["variant"] for entry in results], [
                "document-dvh", "document-percent", "relayout", "resize-never",
                "never", "automatic", "zero-insets", "resize"])
            self.assertEqual(len(captures), 8)
            self.assertGreaterEqual(now[0], 140)
            self.assertEqual(original.read_bytes(), b"original")
            self.assertEqual(json.loads((root / "phone.experiments.json").read_text()), results)

    def test_viewport_comparison_rejects_stale_variant(self):
        now = [0.0]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def sleep(seconds):
                now[0] += seconds
            with patch.object(smoke.time, "time", return_value=100), \
                    patch.object(smoke.time, "monotonic", side_effect=lambda: now[0]), \
                    patch.object(smoke.time, "sleep", side_effect=sleep), \
                    patch.object(smoke, "read_layout_snapshots", return_value=[{"variant": "baseline", "capturedAt": 200}]), \
                    patch.object(smoke, "simctl") as capture:
                with self.assertRaisesRegex(RuntimeError, "viewport"):
                    smoke.capture_viewport_experiments("owned-device", root, root, "phone")
                capture.assert_not_called()

    def test_layout_snapshots_exclude_unrelated_cache_files(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            (cache / "layout-2-0.json").write_text('{"delaySeconds":2}')
            (cache / "layout-10-0.json").write_text(json.dumps({"delaySeconds": 10, "dom": {"rects": [
                {"selector": "#root", "height": 800}, {"selector": ".app--mobile", "height": 800}]}}))
            (cache / "unrelated.json").write_text('not a layout snapshot')
            snapshots = smoke.read_layout_snapshots(cache, timeout=0)
            self.assertEqual({entry["delaySeconds"] for entry in snapshots}, {2, 10})

    def test_layout_snapshots_do_not_claim_success_without_native_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "未產生"):
                smoke.read_layout_snapshots(Path(directory), timeout=0)

    def test_layout_snapshots_require_rendered_app_geometry(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            (cache / "layout-10-0.json").write_text('{"delaySeconds":10,"dom":{"rects":[{"selector":"#root"}]}}')
            with self.assertRaisesRegex(RuntimeError, "早於前端"):
                smoke.read_layout_snapshots(cache, timeout=0)

    def test_failed_frontend_preserves_early_layout_as_partial_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            (cache / "layout-2-0.json").write_text('{"delaySeconds":2}')
            self.assertEqual(smoke.read_layout_snapshots(cache, timeout=0, require_ready=False), [{"delaySeconds": 2}])

    def test_failure_probes_do_not_conflate_ocr_and_simulator_stalls(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            (output / "iPhone.png").write_bytes(b"fixture")
            def probe(command, **kwargs):
                self.assertEqual(kwargs["timeout"], 15)
                if "simctl" in command:
                    raise subprocess.TimeoutExpired(command, 15)
                if command[0] == "reader":
                    return subprocess.CompletedProcess(command, 0, '["No connections yet", "Add connection"]', "")
                return subprocess.CompletedProcess(command, 0, "host responds", "")
            with patch.object(smoke.subprocess, "run", side_effect=probe):
                result = smoke.failure_diagnostics("owned-device", output, Path("reader"))
            self.assertTrue(result["knownGoodOCR"]["frontendVisible"])
            self.assertTrue(result["hostProcesses"]["completed"])
            self.assertFalse(result["simulatorProcesses"]["completed"])
            self.assertFalse(result["webViewLog"]["completed"])

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
    def test_completed_blank_captures_stay_within_the_stall_budget(self):
        now = [0.0]
        attempts = []
        with tempfile.TemporaryDirectory() as directory:
            screenshot = Path(directory) / "blank.png"

            def capture(*args, **kwargs):
                attempts.append(kwargs["timeout"])
                if len(attempts) > 100:
                    raise AssertionError("Capture loop did not terminate")
                screenshot.write_bytes(b"\x89PNG\r\n\x1a\n" + smoke.PNG_END)
                now[0] += kwargs["timeout"]
                raise subprocess.TimeoutExpired(args, kwargs["timeout"])

            def sleep(seconds):
                now[0] += seconds

            with patch.object(smoke.time, "monotonic", side_effect=lambda: now[0]), \
                    patch.object(smoke.time, "sleep", side_effect=sleep), \
                    patch.object(smoke.os, "kill"), \
                    patch.object(smoke, "simctl", side_effect=capture), \
                    patch.object(smoke.subprocess, "run", return_value=subprocess.CompletedProcess(
                        [], 0, stdout='["status bar only"]')):
                with self.assertRaises(RuntimeError):
                    smoke.wait_for_frontend("owned-device", 123, screenshot, Path("reader"))
            self.assertLessEqual(now[0], 90 + 2 * 60)
            self.assertEqual(json.loads(screenshot.with_suffix(".ocr.json").read_text()), ["status bar only"])
            self.assertTrue(screenshot.is_file())

    def test_a_stalled_capture_does_not_spend_the_apps_readiness_budget(self):
        now = [0.0]
        attempts = []

        def capture(*args, **kwargs):
            attempts.append(kwargs["timeout"])
            if len(attempts) == 1:
                now[0] += kwargs["timeout"]
                raise subprocess.TimeoutExpired(args, kwargs["timeout"])
            now[0] += 2

        with patch.object(smoke.time, "monotonic", side_effect=lambda: now[0]), \
                patch.object(smoke.os, "kill"), \
                patch.object(smoke, "simctl", side_effect=capture), \
                patch.object(smoke.subprocess, "run", return_value=subprocess.CompletedProcess(
                    [], 0, stdout='["No connections yet", "Add connection"]')) as recognize:
            result = smoke.wait_for_frontend("owned-device", 123, Path("capture.png"), Path("reader"))
        self.assertTrue(result["renderedStartup"])
        # The retry gets a full attempt rather than the 30 seconds the stall
        # left behind, and the partial image is still never recognized.
        self.assertEqual(attempts, [60, 60])
        self.assertEqual(recognize.call_count, 1)
        self.assertEqual(recognize.call_args.kwargs["timeout"], 45)

    def test_a_finished_capture_whose_command_hangs_is_still_recognized(self):
        now = [0.0]
        attempts = []

        with tempfile.TemporaryDirectory() as directory:
            screenshot = Path(directory) / "capture.png"

            def capture(*args, **kwargs):
                attempts.append(kwargs["timeout"])
                # The first hang leaves half a PNG; the second a whole one.
                body = b"\x89PNG\r\n\x1a\n" + (smoke.PNG_END if len(attempts) == 2 else b"IDAT")
                screenshot.write_bytes(body)
                now[0] += kwargs["timeout"]
                raise subprocess.TimeoutExpired(args, kwargs["timeout"])

            with patch.object(smoke.time, "monotonic", side_effect=lambda: now[0]), \
                    patch.object(smoke.os, "kill"), \
                    patch.object(smoke, "simctl", side_effect=capture), \
                    patch.object(smoke.subprocess, "run", return_value=subprocess.CompletedProcess(
                        [], 0, stdout='["No connections yet", "Add connection"]')) as recognize:
                result = smoke.wait_for_frontend("owned-device", 123, screenshot, Path("reader"))
        self.assertTrue(result["renderedStartup"])
        self.assertEqual(attempts, [60, 60])
        recognize.assert_called_once()

    def test_an_old_complete_capture_does_not_pass_for_a_new_one(self):
        with tempfile.TemporaryDirectory() as directory:
            screenshot = Path(directory) / "capture.png"
            screenshot.write_bytes(b"\x89PNG\r\n\x1a\n" + smoke.PNG_END)
            self.assertTrue(smoke.finished_capture(screenshot, 0))
            self.assertFalse(smoke.finished_capture(screenshot, screenshot.stat().st_mtime + 5))
            self.assertFalse(smoke.finished_capture(Path(directory) / "missing.png", 0))

    def test_a_wedged_simulator_stops_in_bounded_time_and_leaves_evidence(self):
        now = [0.0]
        attempts = []

        def capture(*args, **kwargs):
            attempts.append(kwargs["timeout"])
            now[0] += kwargs["timeout"]
            raise subprocess.TimeoutExpired(args, kwargs["timeout"])

        with tempfile.TemporaryDirectory() as directory, \
                patch.object(smoke.time, "monotonic", side_effect=lambda: now[0]), \
                patch.object(smoke.os, "kill"), \
                patch.object(smoke, "simctl", side_effect=capture), \
                patch.object(smoke.subprocess, "run") as recognize:
            screenshot = Path(directory) / "capture.png"
            # Names the device that never showed its screen, not `xcrun`, and
            # says the captures stalled rather than the app rendering slowly.
            with self.assertRaisesRegex(RuntimeError, "owned-device.*停擺"):
                smoke.wait_for_frontend("owned-device", 123, screenshot, Path("reader"))
            self.assertEqual(json.loads(screenshot.with_suffix(".ocr.json").read_text()), [])
        # Two stalls are absorbed, the third gives up: bounded at 90 + 2 x 60.
        self.assertEqual(attempts, [60, 60, 60])
        self.assertEqual(now[0], 180)
        recognize.assert_not_called()

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

    def test_persistent_ocr_timeouts_also_stop_after_the_stall_allowance(self):
        now = [0.0]
        attempts = []

        def recognize(*args, **kwargs):
            attempts.append(kwargs["timeout"])
            now[0] += kwargs["timeout"]
            raise subprocess.TimeoutExpired(args, kwargs["timeout"])

        with tempfile.TemporaryDirectory() as directory, \
                patch.object(smoke.time, "monotonic", side_effect=lambda: now[0]), \
                patch.object(smoke.os, "kill"), \
                patch.object(smoke, "simctl"), \
                patch.object(smoke.subprocess, "run", side_effect=recognize):
            with self.assertRaisesRegex(RuntimeError, "owned-device.*停擺"):
                smoke.wait_for_frontend(
                    "owned-device", 123, Path(directory) / "capture.png", Path("reader"), timeout=70)
        self.assertEqual(attempts, [45, 45, 45])
        self.assertEqual(now[0], 135)

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
