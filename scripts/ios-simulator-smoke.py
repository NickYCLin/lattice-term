"""Verify the app on disposable iPhone and iPad simulators locally or in CI."""
import argparse
import json
import os
import plistlib
import re
import subprocess
import sys
import tempfile
import time
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


def simctl(*args, timeout=60, env=None):
    return subprocess.run(
        ["xcrun", "simctl", *map(str, args)],
        check=True, capture_output=True, text=True, timeout=timeout, env=env,
    ).stdout.strip()


def failure_diagnostics(device_id, directory, reader):
    probes = {
        "hostProcesses": ["/bin/ps", "-axo", "pid,ppid,state,%cpu,%mem,comm"],
        "simulatorProcesses": ["xcrun", "simctl", "spawn", device_id, "launchctl", "list"],
        "webViewLog": ["xcrun", "simctl", "spawn", device_id, "log", "show", "--style", "compact", "--last", "3m",
                       "--predicate", 'process == "LatticeTerm" OR process BEGINSWITH "com.apple.WebKit"'],
        "simulatorHostLog": ["/usr/bin/log", "show", "--style", "compact", "--last", "3m",
                             "--predicate", 'process == "CoreSimulatorService"'],
    }
    known_image = directory / "iPhone.png"
    if reader and known_image.is_file():
        probes["knownGoodOCR"] = [str(reader), str(known_image.resolve())]
    results = {}
    for name, command in probes.items():
        try:
            result = subprocess.run(command, check=True, capture_output=True, text=True, timeout=15)
            results[name] = {"completed": True, "stdout": result.stdout[-65536:], "stderr": result.stderr[-8192:]}
            if name == "knownGoodOCR":
                results[name]["frontendVisible"] = frontend_is_visible(json.loads(result.stdout))
        except Exception as probe_error:
            results[name] = {"completed": False, "error": f"{type(probe_error).__name__}: {probe_error}"[:2048]}
    return results


def capture_failure(device_id, label, stage, error, directory, reader=None):
    # This device was created by this invocation. Write the cause before any
    # best-effort capture, so even an unresponsive simulator leaves evidence.
    path = directory / f"{label}.failure.json"
    report = {"stage": stage, "errorType": type(error).__name__, "error": str(error)[:2048]}
    for stream in ("stdout", "stderr"):
        value = getattr(error, stream, None)
        if value:
            report[stream] = (value.decode("utf-8", errors="replace") if isinstance(value, bytes) else str(value))[-8192:]
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    report["diagnostics"] = failure_diagnostics(device_id, directory, reader)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    screenshot = directory / f"{label}.failure.png"
    try:
        simctl("io", device_id, "screenshot", screenshot.resolve(), timeout=15)
        report["screenshot"] = screenshot.name
    except Exception as capture_error:
        report["captureError"] = f"{type(capture_error).__name__}: {capture_error}"[:2048]
    try:
        logs = simctl("spawn", device_id, "log", "show", "--style", "compact", "--last", "3m",
                      "--predicate", 'eventMessage CONTAINS[c] "io.github.nickyclin.latticeterm"', timeout=15)
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
    for variant in ("never", "automatic", "zero-insets", "resize"):
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--local", action="store_true", help="在本機以符合 App 最低版本的 runtime 驗證；只建立及清理本次測試裝置")
    parser.add_argument("--boot-timeout", type=int, default=180, help="新裝置開機與系統資料移轉的等待秒數，預設 180，範圍 30–1800；不影響 App 畫面期限")
    parser.add_argument("--store-screenshots", action="store_true", help="另產生符合商店尺寸且不含 Alpha 的原始截圖候選素材")
    parser.add_argument("--layout-diagnostics", action="store_true", help="僅在新建模擬器蒐集原生 frame、安全區與無文字內容的 DOM 幾何")
    parser.add_argument("--viewport-experiments", action="store_true", help="僅在隔離模擬器對照原生 inset 與 resize，不作為產品驗收")
    args = parser.parse_args()
    if args.viewport_experiments and not args.layout_diagnostics:
        parser.error("--viewport-experiments 需要 --layout-diagnostics")
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
        check_simulators(args, runtime, devices, reader)


def check_simulators(args, runtime, devices, reader):
    report = []
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
            print(f"{label}: 啟動新的 {model['name']} 模擬器", flush=True)
            simctl("boot", device_id)
            stage = "bootstatus"
            simctl("bootstatus", device_id, "-b", timeout=args.boot_timeout)
            stage = "install"
            print(f"{label}: 開機完成，安裝 App", flush=True)
            # A shared runner installing onto a device that just finished
            # booting has taken longer than two minutes; the install itself is
            # not what this smoke test measures, so give it the same room as
            # the launch below.
            simctl("install", device_id, args.app.resolve(), timeout=300)
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
            output = simctl("launch", device_id, BUNDLE_ID, timeout=330, env=launch_env)
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
            if capture_store:
                stage = "store-screenshot"
                entry["appStoreCandidate"] = capture_store_image(device_id, family, args.output)
            if getattr(args, "viewport_experiments", False):
                stage = "viewport-experiments"
                capture_viewport_experiments(device_id, cache, args.output, label)
            stage = "report"
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
            raise
        finally:
            # Cleanup is limited to this invocation's newly created device.
            try:
                simctl("shutdown", device_id)
            finally:
                simctl("delete", device_id)


if __name__ == "__main__":
    main()
