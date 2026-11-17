#!/usr/bin/env python3
"""在隔離模擬器上跑 LatticeTerm 系統軟體鍵盤 XCUITest（非 hardware keyboard、非 typeText）。"""

from __future__ import annotations

import argparse
import json
import os
import plistlib
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

BUNDLE_ID = "io.github.nickyclin.latticeterm"
TEST_IDENTIFIER = "LayoutUITests/SoftwareKeyboardUITests"
DEVICE_NAME = "LatticeTerm SoftwareKeyboard"
KEYBOARDS = [
    "en_US@sw=QWERTY;hw=Automatic",
    "zh_Hant-Hant@sw=Zhuyin;hw=Zhuyin",
    "zh_TW@sw=Zhuyin;hw=Zhuyin",
]


def run(command, timeout=60, check=True, cwd=None, env=None):
    completed = subprocess.run(
        command, capture_output=True, text=True, timeout=timeout, cwd=cwd, env=env
    )
    if check and completed.returncode:
        raise RuntimeError(
            f"指令失敗（{completed.returncode}）：{' '.join(map(str, command))}\n"
            f"{completed.stdout}\n{completed.stderr}"
        )
    return completed


def simctl(*args, timeout=60, check=True):
    return run(["xcrun", "simctl", *args], timeout=timeout, check=check)


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")


def disable_hardware_keyboard(device_id: str, output: Path) -> None:
    run(["defaults", "write", "com.apple.iphonesimulator", "ConnectHardwareKeyboard", "-bool", "NO"])
    run([
        "defaults", "write", "com.apple.iphonesimulator", "DevicePreferences",
        "-dict-add", device_id,
        "<dict><key>ConnectHardwareKeyboard</key><false/></dict>",
    ])
    host = Path.home() / "Library/Preferences/com.apple.iphonesimulator.plist"
    evidence = {"deviceId": device_id, "globalConnectHardwareKeyboard": None, "devicePreference": None}
    try:
        data = plistlib.loads(host.read_bytes())
        evidence["globalConnectHardwareKeyboard"] = data.get("ConnectHardwareKeyboard")
        evidence["devicePreference"] = (data.get("DevicePreferences") or {}).get(device_id)
    except Exception as error:
        evidence["readError"] = str(error)
    write_json(output / "hardware-keyboard-preference.json", evidence)


def install_zhuyin_keyboards(device_id: str, output: Path) -> None:
    prefs = (
        Path.home()
        / "Library/Developer/CoreSimulator/Devices"
        / device_id
        / "data/Library/Preferences"
    )
    prefs.mkdir(parents=True, exist_ok=True)
    payload = {
        "AppleKeyboards": KEYBOARDS,
        "AppleLanguages": ["zh-Hant-TW", "en"],
        "AppleLocale": "zh_TW",
    }
    global_plist = prefs / ".GlobalPreferences.plist"
    data = plistlib.loads(global_plist.read_bytes()) if global_plist.exists() else {}
    data.update(payload)
    global_plist.write_bytes(plistlib.dumps(data, fmt=plistlib.FMT_BINARY))

    kb_plist = prefs / "com.apple.keyboard.preferences.plist"
    kb = plistlib.loads(kb_plist.read_bytes()) if kb_plist.exists() else {}
    kb["AppleKeyboards"] = KEYBOARDS
    kb["DidShowContinuousPathIntroduction"] = True
    kb_plist.write_bytes(plistlib.dumps(kb, fmt=plistlib.FMT_BINARY))

    domains = [
        ["-g"],
        ["com.apple.keyboard.preferences"],
        ["com.apple.keyboard.preferences.types"],
    ]
    for domain in domains:
        simctl("spawn", device_id, "defaults", "write", *domain, "AppleKeyboards", "-array", *KEYBOARDS, timeout=20)
    simctl("spawn", device_id, "defaults", "write", "com.apple.keyboard.preferences",
           "DidShowContinuousPathIntroduction", "-bool", "YES", timeout=20)
    write_json(output / "software-keyboards.json", {
        "keyboards": KEYBOARDS,
        "globalPlist": str(global_plist),
    })


def resolve_device_type(name_or_id: str) -> str:
    types = json.loads(simctl("list", "devicetypes", "--json", timeout=30).stdout)
    for item in types.get("devicetypes", []):
        if item.get("identifier") == name_or_id or item.get("name") == name_or_id:
            return item["identifier"]
    raise RuntimeError(f"找不到機型：{name_or_id}")


def pick_iphone_runtime() -> tuple[str, str]:
    inventory = json.loads(simctl("list", "devices", "--json", timeout=30).stdout)
    runtimes = json.loads(simctl("list", "runtimes", "--json", timeout=30).stdout)
    available = [rt for rt in runtimes.get("runtimes", []) if rt.get("isAvailable") and "iOS" in rt.get("name", "")]
    if not available:
        raise RuntimeError("沒有可用的 iOS runtime")
    available.sort(key=lambda rt: rt.get("version", ""), reverse=True)
    runtime = available[0]["identifier"]
    devices = inventory.get("devices", {}).get(runtime, []) or inventory.get("devices", {}).get(available[0].get("name", ""), [])
    # Prefer iPhone 17 / 16 class from the runtime's supported device types
    types = json.loads(simctl("list", "devicetypes", "--json", timeout=30).stdout)
    candidates = [
        item for item in types.get("devicetypes", [])
        if item.get("productFamily") == "iPhone" and not any(
            token in item.get("name", "") for token in ("SE", "Pod", "Watch")
        )
    ]
    prefer = ["iPhone 17 Pro", "iPhone 16e", "iPhone 16 Pro", "iPhone 16", "iPhone 15 Pro"]
    chosen = None
    for name in prefer:
        chosen = next((item for item in candidates if item["name"] == name), None)
        if chosen:
            break
    if chosen is None:
        chosen = candidates[-1] if candidates else None
    if chosen is None:
        raise RuntimeError("找不到可用的 iPhone 機型")
    return runtime, chosen["identifier"]


def list_physical_iphone13() -> list[dict]:
    command = ["xcrun", "devicectl", "list", "devices", "--json-output", "/tmp/lt-software-keyboard-devices.json"]
    completed = run(command, timeout=30, check=False)
    path = Path("/tmp/lt-software-keyboard-devices.json")
    if not path.exists():
        return []
    data = json.loads(path.read_text())
    found = []
    for device in data.get("result", {}).get("devices", []):
        props = device.get("deviceProperties", {})
        hardware = device.get("hardwareProperties", {})
        name = props.get("name", "")
        marketing = hardware.get("marketingName", "")
        if "iPhone 13" in name or marketing == "iPhone 13":
            conn = device.get("connectionProperties", {})
            found.append({
                "name": name,
                "marketingName": marketing,
                "udid": hardware.get("udid") or device.get("identifier"),
                "transportType": conn.get("transportType"),
                "tunnelState": conn.get("tunnelState"),
                "developerModeStatus": props.get("developerModeStatus"),
            })
    return found


def export_attachments(xcresult: Path, dest: Path) -> str | None:
    if not xcresult.exists():
        return "缺少 xcresult"
    completed = run(
        ["xcrun", "xcresulttool", "export", "attachments", "--path", str(xcresult), "--output-path", str(dest)],
        timeout=90, check=False,
    )
    if completed.returncode:
        return completed.stderr.strip() or completed.stdout.strip() or f"exit {completed.returncode}"
    return None


def main() -> int:
    repo = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description="跑 iOS 系統軟體鍵盤 XCUITest")
    parser.add_argument("--app", type=Path, default=repo / "src-tauri/gen/apple/build/x86_64/LatticeTerm.app")
    parser.add_argument("--output", type=Path, default=repo / "output/ios-software-keyboard")
    parser.add_argument("--boot-timeout", type=int, default=900)
    parser.add_argument("--keep", action="store_true")
    parser.add_argument("--xcodegen", type=Path, default=None)
    parser.add_argument("--device-name", default=DEVICE_NAME, help="新建模擬器名稱")
    parser.add_argument("--device-type", default=None, help="例如 'iPhone SE (3rd generation)' 或 'iPad (A16)'")
    parser.add_argument("--udid", default=None, help="重用已存在的模擬器，不再新建")
    args = parser.parse_args()

    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    report = {"startedAt": time.time(), "stages": [], "iphone13": list_physical_iphone13()}
    write_json(output / "report.json", report)
    if report["iphone13"]:
        connected = [item for item in report["iphone13"] if item.get("transportType") and item.get("tunnelState") != "unavailable"]
        if not connected:
            print("iPhone 13 仍未接上或 tunnel 不可用，本輪只跑模擬器，不會覆蓋真機上的正式版。", flush=True)
        else:
            print("偵測到已連接的 iPhone 13，依指示先回報、不覆蓋安裝正式版。本輪只跑模擬器。", flush=True)
            write_json(output / "iphone13-connected.json", connected)
    else:
        print("未看到 iPhone 13，本輪只跑模擬器。", flush=True)

    if not args.app.exists():
        raise SystemExit(f"找不到 App：{args.app}")

    xcodegen = args.xcodegen
    if xcodegen is None:
        found = shutil.which("xcodegen")
        fallback = Path.home() / "forge/tools/xcodegen-dist/xcodegen/bin/xcodegen"
        xcodegen = Path(found) if found else fallback
    if not Path(xcodegen).exists():
        raise SystemExit(f"找不到 xcodegen：{xcodegen}")

    runtime, default_type = pick_iphone_runtime()
    device_type = resolve_device_type(args.device_type) if args.device_type else default_type
    report.update(runtime=runtime, deviceType=device_type, deviceName=args.device_name)
    device_id = None
    created_this_run = False
    try:
        if args.udid:
            device_id = args.udid
            report["deviceId"] = device_id
            write_json(output / "report.json", report)
            print(f"重用模擬器 {device_id}", flush=True)
        else:
            created = simctl("create", args.device_name, device_type, runtime, timeout=60)
            device_id = created.stdout.strip()
            created_this_run = True
            report["deviceId"] = device_id
            write_json(output / "report.json", report)
            print(f"啟動模擬器 {device_id}", flush=True)
        simctl("boot", device_id, timeout=120, check=False)
        simctl("bootstatus", device_id, "-b", timeout=args.boot_timeout)

        disable_hardware_keyboard(device_id, output)
        install_zhuyin_keyboards(device_id, output)

        print("安裝 App", flush=True)
        simctl("install", device_id, str(args.app.resolve()), timeout=300)

        work = output / "layout-ui-tests"
        if work.exists():
            shutil.rmtree(work)
        shutil.copytree(repo / "scripts/ios-layout-ui-tests", work)
        print("產生 XCUITest 工程", flush=True)
        run([str(xcodegen), "generate", "--spec", "project.yml"], cwd=work, timeout=60)

        derived = work / "derived"
        destination = f"platform=iOS Simulator,id={device_id}"
        print("編譯 UI 測試", flush=True)
        run([
            "xcodebuild", "build-for-testing",
            "-project", str(work / "LatticeLayoutChecks.xcodeproj"),
            "-scheme", "LayoutUITests",
            "-destination", destination,
            "-derivedDataPath", str(derived),
            "CODE_SIGNING_ALLOWED=NO",
        ], timeout=300)

        result = output / "SoftwareKeyboardUITests.xcresult"
        if result.exists():
            shutil.rmtree(result)
        print("開啟 Simulator（關閉 Connect Hardware Keyboard）", flush=True)
        run([
            "open", "-a", "Simulator", "--args",
            "-CurrentDeviceUDID", device_id,
            "-ConnectHardwareKeyboard", "NO",
        ], timeout=30, check=False)
        time.sleep(8)
        print("預熱 App", flush=True)
        simctl("launch", device_id, BUNDLE_ID, timeout=60, check=False)
        time.sleep(20)
        print("執行軟體鍵盤 XCUITest", flush=True)
        command = [
            "xcodebuild", "test-without-building",
            "-project", str(work / "LatticeLayoutChecks.xcodeproj"),
            "-scheme", "LayoutUITests",
            "-destination", destination,
            "-derivedDataPath", str(derived),
            "-only-testing:" + TEST_IDENTIFIER,
            "-resultBundlePath", str(result),
            "-parallel-testing-enabled", "NO",
            "CODE_SIGNING_ALLOWED=NO",
        ]
        log_path = output / "xcodebuild.log"
        with log_path.open("w") as log_file:
            proc = subprocess.Popen(command, stdout=log_file, stderr=subprocess.STDOUT, text=True)
            try:
                code = proc.wait(timeout=900)
            except subprocess.TimeoutExpired:
                proc.kill()
                try:
                    proc.wait(timeout=30)
                except Exception:
                    pass
                log_path.write_text(log_path.read_text(errors="replace") + "\nXCUITest timed out after 900 seconds\n")
                code = 124
        log = log_path.read_text(errors="replace")
        tested = subprocess.CompletedProcess(command, code, log, "")
        (output / "xcodebuild.log").write_text(log)
        stages = [json.loads(match) for match in re.findall(r"LATTICE_SOFTWARE_KEYBOARD (\{[^\n]+\})", tested.stdout)]
        write_json(output / "stages.json", stages)
        report.update(exitCode=tested.returncode, stages=stages, testsPassed=tested.returncode == 0)
        write_json(output / "report.json", report)
        attachments = output / "attachments"
        export_error = export_attachments(result, attachments)
        report["attachmentExportError"] = export_error
        write_json(output / "report.json", report)
        if tested.returncode:
            print(log[-8000:], flush=True)
            raise SystemExit(f"軟體鍵盤 XCUITest 失敗，exit={tested.returncode}")
        if export_error:
            raise SystemExit(f"測試通過但附件匯出失敗：{export_error}")
        print("軟體鍵盤 XCUITest 通過", flush=True)
        return 0
    finally:
        report["finishedAt"] = time.time()
        write_json(output / "report.json", report)
        if device_id and created_this_run and not args.keep:
            simctl("shutdown", device_id, timeout=60, check=False)
            simctl("delete", device_id, timeout=60, check=False)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
