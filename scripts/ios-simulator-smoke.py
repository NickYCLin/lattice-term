"""Verify the app on disposable iPhone and iPad simulators locally or in CI."""
import argparse
import json
import os
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

BUNDLE_ID = "io.github.nickyclin.latticeterm"


def select_runtime(inventory, info, local=False):
    if info.get("CFBundleSupportedPlatforms") != ["iPhoneSimulator"]:
        raise RuntimeError("啟動驗證需要 Simulator App，不能使用實機 archive")
    minimum = re.fullmatch(r"(\d+)\.(\d+)(?:\.(\d+))?", info.get("MinimumOSVersion", ""))
    if minimum is None:
        raise RuntimeError("無法確認 App 的最低 iOS 版本")
    required = tuple(int(part or 0) for part in minimum.groups())
    if not local:
        required = max(required, (26, 0, 0))
    runtimes = []
    for name, devices in inventory.items():
        match = re.fullmatch(r"com\.apple\.CoreSimulator\.SimRuntime\.iOS-(\d+)-(\d+)(?:-(\d+))?", name)
        if match and devices:
            version = tuple(int(part or 0) for part in match.groups())
            if version >= required:
                runtimes.append((version, name, devices))
    if not runtimes:
        version = ".".join(map(str, required))
        raise RuntimeError(f"未安裝可用的 iOS {version} 以上模擬器 runtime")
    _, runtime, devices = max(runtimes, key=lambda item: item[0])
    return runtime, devices


def store_model(devices, family):
    # Keep the ordinary phone check as well: a Pro Max capture does not replace
    # coverage of the narrower initial device. Apple accepts these native sizes.
    names = (
        ("iPhone 17 Pro Max", "iPhone 16 Pro Max", "iPhone 15 Pro Max", "iPhone 14 Pro Max")
        if family == "iPhone" else
        ("iPad Pro 13-inch (M5)", "iPad Pro 13-inch (M4)", "iPad Pro (12.9-inch) (6th generation)")
    )
    for name in names:
        match = next((device for device in devices if device["name"] == name and device.get("deviceTypeIdentifier")), None)
        if match:
            return match
    raise RuntimeError(f"Runtime 缺少符合 App Store 截圖尺寸的 {family} 機型")


def store_image_metadata(output, family):
    fields = dict(re.findall(r"^\s+(pixelWidth|pixelHeight|hasAlpha|format):\s*(\S+)\s*$", output, re.MULTILINE))
    try:
        size = (int(fields["pixelWidth"]), int(fields["pixelHeight"]))
    except (KeyError, ValueError) as error:
        raise RuntimeError("無法確認 App Store 截圖尺寸") from error
    accepted = (
        {(1260, 2736), (1290, 2796), (1320, 2868)} if family == "iPhone" else
        {(2064, 2752), (2048, 2732)}
    )
    if size not in accepted or fields.get("format") != "jpeg" or fields.get("hasAlpha") != "no":
        raise RuntimeError(f"App Store 截圖必須是符合 {family} 尺寸、不含 Alpha 的原始 JPEG：{fields}")
    return {"width": size[0], "height": size[1], "format": "jpeg", "hasAlpha": False}


def capture_store_image(device_id, family, output):
    directory = output / "app-store"
    directory.mkdir(exist_ok=True)
    screenshot = directory / ("iPhone-6.9.jpg" if family == "iPhone" else "iPad-13.jpg")
    # Capture JPEG directly from the simulator. No resize, UI reconstruction or
    # image conversion: ordinary simctl PNG captures have an alpha channel.
    simctl("io", device_id, "screenshot", "--type=jpeg", screenshot.resolve())
    metadata = subprocess.run(
        ["sips", "-g", "pixelWidth", "-g", "pixelHeight", "-g", "hasAlpha", "-g", "format", str(screenshot.resolve())],
        check=True, capture_output=True, text=True, timeout=20,
        env={**os.environ, "LC_ALL": "C"},
    ).stdout
    return {"screenshot": str(screenshot.relative_to(output)), **store_image_metadata(metadata, family)}


def frontend_is_visible(texts):
    # A live process, status bar or loading spinner is not a usable WebView.
    # Match both independent pieces of the fresh connection page, in either
    # supported language. Ignore OCR whitespace, not missing UI content.
    normalized = ["".join(text.split()).casefold() for text in texts]
    empty_page = ("還沒有任何連線", "noconnectionsyet")
    add_action = ("新增連線", "addconnection")
    return all(
        any(label in text for label in labels for text in normalized)
        for labels in (empty_page, add_action)
    )


# CoreSimulator's screenshot IPC stalls for a whole attempt on some iPad
# runtimes: the capture neither completes nor fails, it just holds the timeout.
# That is the simulator being stuck, not the app being slow to render, so the
# readiness budget is restored afterwards. Stalls are still counted and capped,
# so a permanently wedged device fails in bounded time (90 + 2 x 60 seconds)
# rather than holding the runner.
MAX_CAPTURE_STALLS = 2


PNG_END = b"IEND\xaeB`\x82"


def finished_capture(screenshot, since):
    # On loaded runners simctl often writes the whole iPad PNG and then never
    # exits. A file written during this attempt that ends with the PNG end
    # chunk is complete, so it is recognized instead of counted as a stall.
    # A partly written file still is not.
    try:
        if screenshot.stat().st_mtime < since:
            return False
        with screenshot.open("rb") as image:
            image.seek(-len(PNG_END), os.SEEK_END)
            return image.read() == PNG_END
    except OSError:
        return False


def allow_stall(device_id, stalls):
    if stalls <= MAX_CAPTURE_STALLS:
        return True
    print(f"{device_id}: 截圖連續停擺 {stalls} 次，不再重試", flush=True)
    return False


def wait_for_frontend(device_id, pid, screenshot, reader, timeout=90):
    started = time.monotonic()
    deadline = started + timeout
    maximum_deadline = deadline + MAX_CAPTURE_STALLS * 60
    texts = []
    stalls = 0
    while time.monotonic() < deadline:
        os.kill(pid, 0)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        # Large iPad captures can finish writing before simctl exits on a
        # loaded runner. Keep the shared readiness deadline, but do not impose
        # a shorter 20-second cutoff on a capture that is still completing.
        attempt = time.monotonic()
        # Whole seconds back, for file systems with coarse modification times.
        written_after = time.time() - 1
        try:
            simctl("io", device_id, "screenshot", screenshot.resolve(), timeout=min(60, remaining))
        except subprocess.TimeoutExpired:
            stalls += 1
            deadline = min(maximum_deadline, deadline + time.monotonic() - attempt)
            if finished_capture(screenshot, written_after):
                print(f"{device_id}: 截圖已寫完但指令沒有結束，直接辨識這張", flush=True)
            else:
                if not allow_stall(device_id, stalls):
                    break
                print(f"{device_id}: 截圖指令逾時，重新擷取（第 {stalls} 次停擺）", flush=True)
                continue
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        attempt = time.monotonic()
        try:
            result = subprocess.run(
                [str(reader), str(screenshot.resolve())],
                check=True, capture_output=True, text=True, timeout=min(45, remaining),
            )
        except subprocess.TimeoutExpired:
            stalls += 1
            if not allow_stall(device_id, stalls):
                break
            deadline = min(maximum_deadline, deadline + time.monotonic() - attempt)
            print(f"{device_id}: 截圖辨識逾時，重新擷取（第 {stalls} 次停擺）", flush=True)
            continue
        texts = json.loads(result.stdout)
        if not isinstance(texts, list) or not all(isinstance(text, str) for text in texts):
            raise RuntimeError("Invalid screenshot recognition result")
        if frontend_is_visible(texts):
            os.kill(pid, 0)
            return {"renderedStartup": True, "renderWaitSeconds": round(time.monotonic() - started, 1)}
        if not allow_stall(device_id, stalls):
            break
        time.sleep(min(3, max(0, deadline - time.monotonic())))
    # Keep the last screenshot and recognized text, so a spinner or render
    # failure is reviewable even when the job fails. A stalled capture used to
    # escape as a bare TimeoutExpired, which skipped this evidence and named
    # `xcrun` rather than the device that never showed its first screen.
    screenshot.with_suffix(".ocr.json").write_text(json.dumps(texts, ensure_ascii=False) + "\n")
    stalled = f"，其中 {stalls} 次截圖或辨識停擺" if stalls else ""
    raise RuntimeError(f"{device_id}: 連線頁在 {timeout} 秒內未顯示{stalled}，已保存 {screenshot}")


def stream_text(value):
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value or ""


def recorded_command(command, timeout, path, env=None):
    started = time.monotonic()
    record = {"command": command, "startedAt": time.time(), "timeoutSeconds": timeout,
              "status": "running", "exitCode": None, "pid": None, "stdout": "", "stderr": ""}
    path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n")
    try:
        result = subprocess.run(command, check=True, capture_output=True, text=True, timeout=timeout, env=env)
        record.update(status="completed", exitCode=result.returncode, stdout=result.stdout, stderr=result.stderr)
        if command[:3] == ["xcrun", "simctl", "launch"]:
            match = re.search(r": (\d+)\s*$", result.stdout)
            record["pid"] = int(match[1]) if match else None
        return result.stdout.strip()
    except Exception as error:
        record.update(status="timeout" if isinstance(error, subprocess.TimeoutExpired) else "failed",
                      exitCode=getattr(error, "returncode", None),
                      errorType=type(error).__name__, error=str(error),
                      stdout=stream_text(getattr(error, "stdout", None)),
                      stderr=stream_text(getattr(error, "stderr", None)))
        raise
    finally:
        record.update(finishedAt=time.time(), elapsedSeconds=time.monotonic() - started)
        path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n")


def simctl(*args, timeout=60, env=None, evidence_path=None):
    if evidence_path is not None:
        return recorded_command(["xcrun", "simctl", *map(str, args)], timeout, evidence_path, env)
    return subprocess.run(
        ["xcrun", "simctl", *map(str, args)],
        check=True, capture_output=True, text=True, timeout=timeout, env=env,
    ).stdout.strip()


def log_interval(started_at, finished_at):
    return ["--start", datetime.fromtimestamp(started_at - 5, timezone.utc).strftime("%Y-%m-%d %H:%M:%S%z"),
            "--end", datetime.fromtimestamp(finished_at + 1, timezone.utc).strftime("%Y-%m-%d %H:%M:%S%z")]


def failure_diagnostics(device_id, directory, reader, interval=None, label="failure"):
    if interval is None:
        now = time.time()
        interval = log_interval(now, now)
    probes = {
        "hostProcesses": ["/bin/ps", "-axo", "pid,ppid,state,%cpu,%mem,comm"],
        "simulatorProcesses": ["xcrun", "simctl", "spawn", device_id, "launchctl", "list"],
        "appLaunchLog": ["xcrun", "simctl", "spawn", device_id, "log", "show", "--style", "compact", "--info", "--debug", *interval,
                         "--predicate", f'eventMessage CONTAINS[c] "{BUNDLE_ID}" OR process == "LatticeTerm"'],
        "appLaunchHostLog": ["/usr/bin/log", "show", "--style", "compact", "--info", "--debug", *interval,
                             "--predicate", f'eventMessage CONTAINS[c] "{BUNDLE_ID}" OR eventMessage CONTAINS[c] "{device_id}"'],
        "webViewLog": ["xcrun", "simctl", "spawn", device_id, "log", "show", "--style", "compact", "--info", "--debug", *interval,
                       "--predicate", 'process == "LatticeTerm" OR process BEGINSWITH "com.apple.WebKit" OR process == "SpringBoard" OR process == "runningboardd"'],
        "simulatorHostLog": ["/usr/bin/log", "show", "--style", "compact", "--info", "--debug", *interval,
                             "--predicate", 'process == "CoreSimulatorService" OR process == "Simulator" OR process == "SimulatorTrampoline" OR process == "runningboardd"'],
    }
    known_image = directory / "iPhone.png"
    if reader and known_image.is_file():
        probes["knownGoodOCR"] = [str(reader), str(known_image.resolve())]
    results = {}
    for name, command in probes.items():
        evidence = directory / f"{label}.{name}.command.json"
        try:
            output = recorded_command(command, 15, evidence)
            results[name] = {"completed": True}
            if name == "knownGoodOCR":
                results[name]["frontendVisible"] = frontend_is_visible(json.loads(output))
        except Exception as probe_error:
            results[name] = {"completed": False, "error": f"{type(probe_error).__name__}: {probe_error}"[:2048]}
        record = json.loads(evidence.read_text())
        results[name].update(commandEvidence=evidence.name, status=record["status"],
                             exitCode=record["exitCode"], timeoutSeconds=record["timeoutSeconds"],
                             stdout=record["stdout"][-65536:], stderr=record["stderr"][-8192:])
    return results


def capture_failure(device_id, label, stage, error, directory, reader=None):
    # This device was created by this invocation. Write the cause before any
    # best-effort capture, so even an unresponsive simulator leaves evidence.
    path = directory / f"{label}.failure.json"
    report = {"stage": stage, "errorType": type(error).__name__, "error": str(error)[:2048]}
    startup_path = directory / f"{label}.startup.json"
    started_at = json.loads(startup_path.read_text())["startedAt"] if startup_path.exists() else time.time()
    report["startupCommands"] = {}
    for phase in ("install", "launch"):
        command_path = directory / f"{label}.{phase}.command.json"
        if command_path.exists():
            record = json.loads(command_path.read_text())
            if record.get("startedAt", 0) >= started_at:
                report["startupCommands"][phase] = record
    report["logInterval"] = {"startedAt": started_at, "failureAt": time.time()}
    interval = log_interval(started_at, report["logInterval"]["failureAt"])
    for stream in ("stdout", "stderr"):
        value = getattr(error, stream, None)
        if value:
            report[stream] = (value.decode("utf-8", errors="replace") if isinstance(value, bytes) else str(value))[-8192:]
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    report["diagnostics"] = failure_diagnostics(device_id, directory, reader, interval, label)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    screenshot = directory / f"{label}.failure.png"
    try:
        simctl("io", device_id, "screenshot", screenshot.resolve(), timeout=15)
        report["screenshot"] = screenshot.name
    except Exception as capture_error:
        report["captureError"] = f"{type(capture_error).__name__}: {capture_error}"[:2048]
    try:
        logs = simctl("spawn", device_id, "log", "show", "--style", "compact", "--info", "--debug", *interval,
                      "--predicate", 'eventMessage CONTAINS[c] "io.github.nickyclin.latticeterm"', timeout=15,
                      evidence_path=directory / f"{label}.bundleLog.command.json")
        log_path = directory / f"{label}.failure.log"
        log_path.write_text(logs[-262144:])
        report["systemLog"] = log_path.name
    except Exception as log_error:
        report["logError"] = f"{type(log_error).__name__}: {log_error}"[:2048]
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")


def read_layout_snapshots(cache, timeout=15, require_ready=True):
    deadline = time.monotonic() + timeout
    while True:
        snapshots = [json.loads(path.read_text()) for path in sorted(cache.glob("layout-*.json"))]
        ready = any(
            all(any(rect.get("selector") == selector and rect.get("height", 0) > 0
                    for rect in entry.get("dom", {}).get("rects", []))
                for selector in ("#root", ".app--mobile"))
            for entry in snapshots
        )
        if not require_ready or (ready and any(entry.get("delaySeconds") == 10 for entry in snapshots)):
            break
        if time.monotonic() >= deadline:
            break
        time.sleep(0.5)
    if not snapshots:
        raise RuntimeError("模擬器未產生原生與 DOM 幾何診斷")
    if require_ready and not ready:
        raise RuntimeError("幾何診斷早於前端完成，缺少 root 與 mobile app 尺寸")
    return snapshots


def capture_viewport_experiments(device_id, cache, output, label):
    results = []
    for variant in ("document-dvh", "document-percent", "relayout", "resize-never", "never", "automatic", "zero-insets", "resize"):
        started = time.time()
        pending = cache / "layout-variant.tmp"
        pending.write_text(variant)
        pending.replace(cache / "layout-variant.txt")
        deadline = time.monotonic() + 30
        while True:
            snapshots = read_layout_snapshots(cache, timeout=0)
            matching = [entry for entry in snapshots
                        if entry.get("variant") == variant and entry.get("capturedAt", 0) >= started + 5]
            if matching:
                latest = max(matching, key=lambda entry: entry["capturedAt"])
                break
            if time.monotonic() >= deadline:
                raise RuntimeError(f"缺少 viewport 對照幾何：{variant}")
            time.sleep(0.5)
        screenshot = output / f"{label}.{variant}.png"
        simctl("io", device_id, "screenshot", screenshot.resolve(), timeout=60)
        results.append({"variant": variant, "layout": latest, "screenshot": screenshot.name})
        (output / f"{label}.experiments.json").write_text(json.dumps(results, indent=2) + "\n")
    return results


def build_interaction_runner(directory):
    project = directory / "layout-ui-tests"
    shutil.copytree(Path(__file__).with_name("ios-layout-ui-tests"), project)
    subprocess.run(["xcodegen", "generate", "--spec", "project.yml"], cwd=project, check=True, timeout=60)
    derived = project / "derived"
    subprocess.run(["xcodebuild", "build-for-testing", "-project", str(project / "LatticeLayoutChecks.xcodeproj"),
                    "-scheme", "LayoutUITests", "-destination", "generic/platform=iOS Simulator",
                    "-derivedDataPath", str(derived), "CODE_SIGNING_ALLOWED=NO"], check=True, timeout=300)
    return project, derived


def capture_app_processes(device_id, pid, output, label, stage):
    executable = Path(simctl("get_app_container", device_id, BUNDLE_ID, "app")) / "LatticeTerm"
    result = subprocess.run(["/bin/ps", "-axo", "pid=,ppid=,comm="],
                            check=True, capture_output=True, text=True, timeout=15)
    processes = []
    for line in result.stdout.splitlines():
        fields = line.strip().split(None, 2)
        if len(fields) == 3 and Path(fields[2]).resolve() == executable.resolve():
            processes.append({"pid": int(fields[0]), "parentPid": int(fields[1])})
    evidence = {"stage": stage, "capturedAt": time.time(), "expectedPid": pid, "processes": processes}
    (output / f"{label}.{stage}.processes.json").write_text(json.dumps(evidence, indent=2) + "\n")
    if [process["pid"] for process in processes] != [pid]:
        raise RuntimeError(f"隔離 App 必須只有啟動的單一程序：{label}，實際 {len(processes)} 個")


def validate_native_viewport(snapshot, keyboard=False, keyboard_frame=None, controls=None):
    dom = snapshot.get("dom", {})
    viewport = dom.get("viewport", {})
    window = snapshot.get("windowBounds", {})
    app = next((rect for rect in dom.get("rects", []) if rect.get("selector") == ".app--mobile"), {})
    height = viewport.get("height", 0)
    if height <= 0 or abs(app.get("height", 0) - height) > 1:
        raise RuntimeError("App 高度未跟隨已載入的 visual viewport")
    top = viewport.get("offsetTop", 0) - snapshot.get("scrollBounds", {}).get("y", 0)
    if abs(app.get("y", -100) - top) > 1:
        raise RuntimeError("App 起點未跟隨 visual viewport")
    if not keyboard and any(abs(dom.get(dom_key, 0) - window.get(window_key, -100)) > 1
                            for dom_key, window_key in (("innerWidth", "width"), ("innerHeight", "height"))):
        raise RuntimeError("鍵盤關閉時 DOM 仍短於原生視窗，不能通過全畫面驗收")
    if not keyboard and abs(height - window.get("height", -100)) > 1:
        raise RuntimeError("鍵盤關閉時 visual viewport 仍短於原生視窗")
    if keyboard_frame is not None and keyboard:
        native_top = snapshot.get("webviewInWindow", {}).get("y", 0)
        if keyboard_frame.get("height", 0) <= 100 or height + native_top > keyboard_frame.get("y", 0) + 1:
            raise RuntimeError("App 可見 viewport 與原生鍵盤重疊")
        if dom.get("innerHeight", 0) - height <= 100:
            raise RuntimeError("原生鍵盤顯示時 visual viewport 未縮小")
    for rect in dom.get("rects", []):
        if rect.get("selector") in (".rail", ".drawer__foot") and rect.get("height", 0) > 0:
            if rect.get("y", -100) < top - 1 or rect.get("y", 0) + rect["height"] > top + height + 1:
                raise RuntimeError(f"控制列超出可見 viewport：{rect['selector']}")
    if controls is not None:
        native = snapshot.get("webviewInWindow", {})
        for control in controls:
            rect = control["frame"]
            if (rect.get("x", 0) < -1 or rect.get("y", -100) < -1
                    or rect.get("x", 0) + rect.get("width", 0) > window.get("width", 0) + 1
                    or rect.get("y", 0) + rect.get("height", 0) > window.get("height", 0) + 1):
                raise RuntimeError("原生控制項超出視窗")
        if keyboard:
            for selector, control in zip((".drawer input", ".drawer__head button"), controls):
                rect = next((rect for rect in dom.get("rects", []) if rect.get("selector") == selector), {})
                frame = control["frame"]
                center_x = frame.get("x", 0) + frame.get("width", 0) / 2 - native.get("x", 0)
                center_y = frame.get("y", 0) + frame.get("height", 0) / 2 - native.get("y", 0)
                if (rect.get("width", 0) <= 0 or rect.get("height", 0) <= 0
                        or rect.get("y", -100) < top - 1
                        or rect.get("y", 0) + rect.get("height", 0) > top + height + 1
                        or not rect.get("x", 0) - 1 <= center_x <= rect.get("x", 0) + rect.get("width", 0) + 1
                        or not rect.get("y", 0) - 1 <= center_y <= rect.get("y", 0) + rect.get("height", 0) + 1):
                    raise RuntimeError(f"原生與 DOM 控制項可見座標不符：{selector}")
                if selector == ".drawer input":
                    body = next((rect for rect in dom.get("rects", []) if rect.get("selector") == ".drawer__body"), {})
                    if (body.get("height", 0) <= 0 or rect["y"] < body.get("y", 0) - 1
                            or rect["y"] + rect["height"] > body.get("y", 0) + body.get("height", 0) + 1):
                        raise RuntimeError("輸入欄位被表單標題或底列遮擋")
            if len(controls) != 2:
                raise RuntimeError("缺少鍵盤開啟時的輸入欄位與關閉按鈕")


def capture_input_diagnostics(device_id, output, label, inputs):
    before = next((entry for entry in reversed(inputs) if entry.get("phase") == "before"), None)
    if before is None:
        return
    after = next((entry for entry in reversed(inputs)
                  if entry.get("id") == before.get("id") and entry.get("phase") == "after"), before)
    started, finished = before.get("at"), after.get("at")
    if not all(isinstance(value, (int, float)) and 0 < value < 1e11 for value in (started, finished)):
        return
    if finished < started:
        return
    truncated = finished - started > 30
    ranges = [(started, started + 5), (finished - 5, finished)] if truncated else [(started, finished)]
    windows = [{"start": begin - 5, "end": end + 1} for begin, end in ranges]
    report = {"touchDurationSeconds": finished - started, "truncated": truncated,
              "afterAvailable": after is not before, "windows": windows,
              "omittedInterval": {"start": windows[0]["end"], "end": windows[-1]["start"]} if truncated else None}
    (output / f"{label}.input-diagnostics.json").write_text(json.dumps(report, indent=2) + "\n")
    for index, (begin, end) in enumerate(ranges):
        suffix = ".before" if truncated and index == 0 else ""
        capture_input_window(device_id, output, label, log_interval(begin, end), suffix)


def capture_input_window(device_id, output, label, interval, suffix):
    probes = {
        "inputSimulatorLog": ["xcrun", "simctl", "spawn", device_id, "log", "show", "--style", "compact", "--info", "--debug", *interval,
                              "--predicate", 'process == "backboardd" OR process == "SpringBoard" OR process == "testmanagerd" OR process == "LatticeTerm" OR process BEGINSWITH "com.apple.WebKit" OR process CONTAINS "LayoutUITests"'],
        "inputHostLog": ["/usr/bin/log", "show", "--style", "compact", "--info", "--debug", *interval,
                         "--predicate", 'process == "Simulator" OR process == "SimulatorTrampoline" OR process == "CoreSimulatorService" OR process == "testmanagerd" OR process == "xcodebuild" OR subsystem CONTAINS[c] "HID" OR subsystem CONTAINS[c] "XCTest"'],
    }
    for name, command in probes.items():
        try:
            recorded_command(command, 15, output / f"{label}.{name}{suffix}.command.json")
        except Exception:
            pass


def capture_interactions(device_id, cache, output, label, runner):
    project, derived = runner
    result = output.resolve() / f"{label}.xcresult"
    command = ["xcodebuild", "test-without-building", "-project", str(project / "LatticeLayoutChecks.xcodeproj"),
               "-scheme", "LayoutUITests", "-destination", f"platform=iOS Simulator,id={device_id}",
               "-derivedDataPath", str(derived), "-resultBundlePath", str(result),
               "-parallel-testing-enabled", "NO", "CODE_SIGNING_ALLOWED=NO"]
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=300)
    except subprocess.TimeoutExpired as error:
        stdout = error.stdout.decode(errors="replace") if isinstance(error.stdout, bytes) else error.stdout or ""
        stderr = error.stderr.decode(errors="replace") if isinstance(error.stderr, bytes) else error.stderr or ""
        completed = subprocess.CompletedProcess(command, 124, stdout, stderr + "\nXCUITest timed out after 300 seconds")
    (output / f"{label}.interactions.log").write_text(completed.stdout + completed.stderr)
    snapshots = read_layout_snapshots(cache, timeout=0, require_ready=False)
    (output / f"{label}.interaction-layout.json").write_text(json.dumps(snapshots, indent=2) + "\n")
    inputs = [json.loads(match) for match in re.findall(r"LATTICE_LAYOUT_INPUT (\{[^\n]+\})", completed.stdout)]
    (output / f"{label}.inputs.json").write_text(json.dumps(inputs, indent=2) + "\n")
    stages = [json.loads(match) for match in re.findall(r"LATTICE_LAYOUT_STAGE (\{[^\n]+\})", completed.stdout)]
    for stage in stages:
        matching = [snapshot for snapshot in snapshots
                    if stage["capturedAt"] - 6 <= snapshot.get("capturedAt", 0)
                    <= min(stage["capturedAt"] + 6, stage.get("captureStableUntil", stage["captureFinishedAt"]))
                    and abs(snapshot.get("capturedAt", 0) - snapshot.get("dom", {}).get("capturedAt", -100)) <= 1
                    and any(rect.get("selector") == ".app--mobile" and rect.get("height", 0) > 0
                            for rect in snapshot.get("dom", {}).get("rects", []))]
        if matching:
            stage["layout"] = min(matching, key=lambda snapshot: abs(snapshot["capturedAt"] - stage["capturedAt"]))
    (output / f"{label}.interactions.json").write_text(json.dumps(stages, indent=2) + "\n")
    if completed.returncode:
        capture_input_diagnostics(device_id, output, label, inputs)
    primary_failure = (f"鍵盤與旋轉驗收失敗：{label}，請檢查 interactions.log 與 xcresult"
                       + ("；XCUITest timed out after 300 seconds" if completed.returncode == 124 else "")) if completed.returncode else None
    export_error = None
    if result.exists():
        try:
            recorded_command(["xcrun", "xcresulttool", "export", "attachments", "--path", str(result),
                              "--output-path", str(output.resolve() / f"{label}.attachments")],
                             60, output / f"{label}.attachments.command.json")
        except Exception as error:
            export_error = str(error)
    (output / f"{label}.interactions.result.json").write_text(json.dumps({
        "exitCode": completed.returncode, "timedOut": completed.returncode == 124,
        "primaryFailure": primary_failure, "attachmentExportError": export_error,
    }, ensure_ascii=False, indent=2) + "\n")
    if completed.returncode:
        raise RuntimeError(primary_failure)
    if export_error:
        raise RuntimeError(f"互動附件採證失敗：{label}：{export_error}")
    if [stage["stage"] for stage in stages] != ["keyboard-open", "keyboard-closed", "landscape", "portrait-return"]:
        raise RuntimeError("鍵盤與旋轉驗收缺少完整階段紀錄")
    for stage in stages:
        if "layout" not in stage:
            raise RuntimeError(f"鍵盤與旋轉階段缺少新鮮原生幾何：{stage['stage']}")
    for stage in stages:
        keyboard = stage.get("keyboardVisible", False)
        if keyboard != (stage["stage"] == "keyboard-open"):
            raise RuntimeError(f"原生鍵盤狀態不符驗收階段：{stage['stage']}")
        frame = stage.get("keyboardFrame", {})
        validate_native_viewport(stage["layout"], keyboard=keyboard, keyboard_frame=frame, controls=stage.get("controls", []))
        if not stage.get("controls"):
            raise RuntimeError(f"缺少原生控制項可用性證據：{stage['stage']}")
        for control in stage["controls"]:
            rect = control["frame"]
            if not control.get("hittable") or rect.get("width", 0) <= 0 or rect.get("height", 0) <= 0:
                raise RuntimeError("原生控制項無法點擊")
            if keyboard and rect["y"] + rect["height"] > frame.get("y", 0) + 1:
                raise RuntimeError("原生控制項被鍵盤遮擋")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--local", action="store_true", help="在本機以符合 App 最低版本的 runtime 驗證；只建立及清理本次測試裝置")
    parser.add_argument("--boot-timeout", type=int, default=180, help="新裝置開機與系統資料移轉的等待秒數，預設 180，範圍 30–1800；不影響 App 畫面期限")
    parser.add_argument("--store-screenshots", action="store_true", help="另產生符合商店尺寸且不含 Alpha 的原始截圖候選素材")
    parser.add_argument("--layout-diagnostics", action="store_true", help="僅在新建模擬器蒐集原生 frame、安全區與無文字內容的 DOM 幾何")
    parser.add_argument("--viewport-experiments", action="store_true", help="僅在隔離模擬器對照原生 inset 與 resize，不作為產品驗收")
    parser.add_argument("--interaction-checks", action="store_true", help="透過 XCUITest 驗證新建模擬器的真鍵盤開關與旋轉，保存原圖及幾何")
    args = parser.parse_args()
    if args.viewport_experiments and not args.layout_diagnostics:
        parser.error("--viewport-experiments 需要 --layout-diagnostics")
    if args.interaction_checks and (not args.layout_diagnostics or args.viewport_experiments):
        parser.error("--interaction-checks 需要 --layout-diagnostics，且不得混用 viewport 對照變更")
    if not 30 <= args.boot_timeout <= 1800:
        parser.error("--boot-timeout 必須介於 30 與 1800 秒之間")
    if os.environ.get("CI") != "true" and not args.local:
        parser.error("本機執行請明確指定 --local；不操作既有個人模擬器")
    if os.environ.get("CI") == "true" and args.local:
        parser.error("CI 不接受 --local，必須保留 iOS 26 以上的驗證要求")
    if not (args.app / "Info.plist").is_file():
        parser.error("找不到已建置的 Simulator App")
    if args.output.exists() and (not args.output.is_dir() or any(args.output.iterdir())):
        parser.error("證據目錄必須為空，請指定新的 --output 路徑，以免混入前次驗證結果")
    args.output.mkdir(parents=True, exist_ok=True)
    inventory = json.loads(simctl("list", "devices", "available", "--json"))["devices"]
    with (args.app / "Info.plist").open("rb") as source:
        runtime, devices = select_runtime(inventory, plistlib.load(source), args.local)
    with tempfile.TemporaryDirectory(prefix="latticeterm-screen-reader-") as directory:
        reader = Path(directory) / "ios-screen-text"
        subprocess.run(
            ["xcrun", "swiftc", str(Path(__file__).with_name("ios-screen-text.swift")), "-o", str(reader)],
            check=True, capture_output=True, text=True, timeout=180,
        )
        args.interaction_runner = build_interaction_runner(Path(directory)) if args.interaction_checks else None
        check_simulators(args, runtime, devices, reader)


def prepare_ci_keyboard(device_id):
    if os.environ.get("CI") != "true":
        return
    subprocess.run([
        "defaults", "write", "com.apple.iphonesimulator", "DevicePreferences",
        "-dict-add", device_id,
        "<dict><key>ConnectHardwareKeyboard</key><false/></dict>",
    ], check=True, capture_output=True, text=True, timeout=15)
    subprocess.run([
        "open", "-a", "Simulator", "--args", "-CurrentDeviceUDID", device_id,
        "-ConnectHardwareKeyboard", "NO",
    ], check=True, capture_output=True, text=True, timeout=30)


def check_simulators(args, runtime, devices, reader):
    report = []
    failures = []
    targets = []
    for family in ("iPhone", "iPad"):
        model = (store_model(devices, family) if args.store_screenshots and family == "iPad" else
                 next((device for device in devices if device["name"].startswith(family) and device.get("deviceTypeIdentifier")), None))
        if model is None:
            raise RuntimeError(f"Runtime {runtime} 缺少 {family} 機型")
        targets.append((family, family, model, args.store_screenshots and family == "iPad"))
    if args.store_screenshots:
        targets.append(("iPhone-AppStore", "iPhone", store_model(devices, "iPhone"), True))
    for label, family, model, capture_store in targets:
        # Create clean devices so no existing profiles, secrets or simulator
        # data are read, modified or included in the screenshots.
        device_id = simctl("create", f"LatticeTerm Smoke {label}", model["deviceTypeIdentifier"], runtime)
        stage = "boot"
        try:
            (args.output / f"{label}.startup.json").write_text(json.dumps({"startedAt": time.time()}) + "\n")
            print(f"{label}: 啟動新的 {model['name']} 模擬器", flush=True)
            simctl("boot", device_id)
            stage = "bootstatus"
            simctl("bootstatus", device_id, "-b", timeout=args.boot_timeout)
            if getattr(args, "interaction_checks", False):
                stage = "keyboard-setup"
                prepare_ci_keyboard(device_id)
            stage = "install"
            print(f"{label}: 開機完成，安裝 App", flush=True)
            # A shared runner installing onto a device that just finished
            # booting has taken longer than two minutes; the install itself is
            # not what this smoke test measures, so give it the same room as
            # the launch below.
            simctl("install", device_id, args.app.resolve(), timeout=300,
                   evidence_path=args.output / f"{label}.install.command.json")
            stage = "launch"
            print(f"{label}: 安裝完成，等待啟動指令", flush=True)
            # CoreSimulatorBridge reports a 300-second launch/boot retry
            # budget on a fresh iOS 26.2 device. A 60-second outer timeout
            # aborted that request before the simulator returned a result.
            # Leave a small IPC margin; the app's separate 90-second rendered
            # startup deadline still starts only after a PID is returned.
            launch_started = time.monotonic()
            launch_env = None
            if getattr(args, "layout_diagnostics", False):
                launch_env = {**os.environ, "SIMCTL_CHILD_LATTICETERM_LAYOUT_DIAGNOSTICS": "1"}
            output = simctl("launch", device_id, BUNDLE_ID, timeout=330, env=launch_env,
                            evidence_path=args.output / f"{label}.launch.command.json")
            launch_seconds = round(time.monotonic() - launch_started, 1)
            match = re.search(r": (\d+)\s*$", output)
            if match is None:
                raise RuntimeError(f"無法讀取 App PID：{output}")
            pid = int(match[1])
            screenshot = args.output / f"{label}.png"
            stage = "frontend"
            print(f"{label}: 已取得 PID，驗證實際連線頁", flush=True)
            visible = wait_for_frontend(device_id, pid, screenshot, reader)
            entry = {"family": family, "model": model["name"], "runtime": runtime, "launchCommandSeconds": launch_seconds, "survivedStartup": True, **visible, "screenshot": screenshot.name}
            if getattr(args, "layout_diagnostics", False):
                container = Path(simctl("get_app_container", device_id, BUNDLE_ID, "data"))
                cache = container / "Library" / "Caches"
                snapshots = read_layout_snapshots(cache)
                (args.output / f"{label}.layout.json").write_text(json.dumps(snapshots, indent=2) + "\n")
                entry["layoutDiagnostics"] = f"{label}.layout.json"
                capture_app_processes(device_id, pid, args.output, label, "baseline")
            if capture_store:
                stage = "store-screenshot"
                entry["appStoreCandidate"] = capture_store_image(device_id, family, args.output)
            if getattr(args, "viewport_experiments", False):
                stage = "viewport-experiments"
                capture_viewport_experiments(device_id, cache, args.output, label)
            if getattr(args, "interaction_checks", False):
                stage = "interaction-checks"
                validate_native_viewport(max(snapshots, key=lambda snapshot: snapshot.get("capturedAt", 0)))
                capture_interactions(device_id, cache, args.output, label, args.interaction_runner)
            stage = "report"
            if getattr(args, "layout_diagnostics", False):
                capture_app_processes(device_id, pid, args.output, label, "completed")
            report.append(entry)
            (args.output / "launch-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
            print(f"{label}: 已辨識連線頁內容，程序仍在執行，已保存 {screenshot}", flush=True)
        except Exception as error:
            if getattr(args, "layout_diagnostics", False) and stage == "frontend":
                try:
                    container = Path(simctl("get_app_container", device_id, BUNDLE_ID, "data"))
                    snapshots = read_layout_snapshots(container / "Library" / "Caches", timeout=0, require_ready=False)
                    (args.output / f"{label}.layout.json").write_text(json.dumps(snapshots, indent=2) + "\n")
                except Exception as layout_error:
                    (args.output / f"{label}.layout-error.json").write_text(json.dumps({"error": str(layout_error)}) + "\n")
            try:
                capture_failure(device_id, label, stage, error, args.output, reader)
            except Exception as evidence_error:
                # Preserve the original failure if the output disk also fails.
                print(f"無法保存失敗證據：{evidence_error}", file=sys.stderr, flush=True)
            if not getattr(args, "interaction_checks", False):
                raise
            failures.append({"device": label, "stage": stage, "error": str(error)})
            (args.output / "interaction-failures.json").write_text(json.dumps(failures, ensure_ascii=False, indent=2) + "\n")
        finally:
            # Cleanup is limited to this invocation's newly created device.
            try:
                simctl("shutdown", device_id)
            finally:
                simctl("delete", device_id)
    if failures:
        raise RuntimeError("原生互動驗收未通過：" + ", ".join(failure["device"] for failure in failures))


if __name__ == "__main__":
    main()
