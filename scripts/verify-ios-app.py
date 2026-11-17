"""Verify a built iOS .app, without credentials or third-party dependencies."""
import argparse
import json
import plistlib
import re
import subprocess
from pathlib import Path


def inspect_required_reason_apis(executable):
    """Conservative C-import inventory, not a replacement for Xcode's report."""
    result = subprocess.run(
        ["xcrun", "nm", "-u", "-j", str(executable)],
        capture_output=True, text=True, check=True, timeout=60,
    )
    symbols = {line.strip().lstrip("_") for line in result.stdout.splitlines()}
    categories = {
        "NSPrivacyAccessedAPICategoryFileTimestamp": {
            "stat", "fstat", "lstat", "fstatat", "getattrlist", "fgetattrlist", "getattrlistbulk",
        },
        "NSPrivacyAccessedAPICategorySystemBootTime": {"mach_absolute_time", "clock_gettime"},
        "NSPrivacyAccessedAPICategoryUserDefaults": {"OBJC_CLASS_$_NSUserDefaults"},
        "NSPrivacyAccessedAPICategoryDiskSpace": {"statfs", "fstatfs", "statvfs", "fstatvfs", "getfsstat"},
    }
    return {category: sorted(symbols & names) for category, names in categories.items() if symbols & names}


def verify(app, version, build_number=None, require_store_sdk=False, check_api_symbols=False, require_declared_api=False):
    with (app / "Info.plist").open("rb") as source:
        info = plistlib.load(source)
    with (app / "PrivacyInfo.xcprivacy").open("rb") as source:
        privacy = plistlib.load(source)
    errors = []
    if info.get("CFBundleIdentifier") != "io.github.nickyclin.latticeterm":
        errors.append("Bundle ID 與專案不一致")
    if info.get("CFBundleShortVersionString") != version:
        errors.append("原生版本與 package.json 不一致")
    if build_number and info.get("CFBundleVersion") != build_number:
        errors.append("建置號與指定值不一致")
    if not info.get("NSLocalNetworkUsageDescription"):
        errors.append("App 缺少區域網路用途說明")
    for key in ("UIFileSharingEnabled", "LSSupportsOpeningDocumentsInPlace"):
        if info.get(key) is not True:
            errors.append(f"App 缺少檔案匯出存取設定：{key}")
    if privacy.get("NSPrivacyTracking") is not False:
        errors.append("隱私清單追蹤宣告不一致")
    reasons = {
        item.get("NSPrivacyAccessedAPIType"): set(item.get("NSPrivacyAccessedAPITypeReasons", []))
        for item in privacy.get("NSPrivacyAccessedAPITypes", [])
    }
    for category, expected in {
        "NSPrivacyAccessedAPICategoryFileTimestamp": {"C617.1", "3B52.1"},
        "NSPrivacyAccessedAPICategorySystemBootTime": {"35F9.1"},
        "NSPrivacyAccessedAPICategoryDiskSpace": {"E174.1"},
    }.items():
        if not expected <= reasons.get(category, set()):
            errors.append(f"隱私清單缺少 {category} 的用途")
    # Only E174.1 matches this app's observed export-space behavior.
    if reasons.get("NSPrivacyAccessedAPICategoryDiskSpace") != {"E174.1"}:
        errors.append("DiskSpace 必須僅宣告符合匯出前空間檢查的 E174.1")
    if require_store_sdk:
        sdk = re.fullmatch(r"iphoneos(\d+)(?:\.\d+)*", info.get("DTSDKName", ""))
        if not sdk or int(sdk[1]) < 26:
            errors.append("送件產物必須使用 iOS 26 以上的實機 SDK")
    executable = app / info.get("CFBundleExecutable", "__missing__")
    if not executable.is_file():
        errors.append("找不到 App 執行檔")
    api_review = {"status": "not_run"}
    if (check_api_symbols or require_store_sdk or require_declared_api) and executable.is_file():
        imports = inspect_required_reason_apis(executable)
        missing = sorted(category for category in imports if not reasons.get(category))
        api_review = {
            "status": "needs_review" if missing else "declared_c_imports",
            "imports": imports, "missingManifestCategories": missing,
            "note": "僅盤點 C API 匯入；仍須 Xcode Privacy Report 與實際用途審查",
        }
        if (require_store_sdk or require_declared_api) and missing:
            errors.append("產物包含未宣告用途的 API 類別，須先查明使用路徑：" + ", ".join(missing))
    for path in app.rglob("*"):
        if path.name.startswith(("lattice-rdp-engine", "lattice-vnc-engine", "lattice-agent", "lattice-remote")):
            errors.append(f"行動版包含桌面 sidecar：{path.name}")
    if errors:
        raise ValueError("\n".join(errors))
    return {
        "app": str(app), "version": info["CFBundleShortVersionString"],
        "buildNumber": info["CFBundleVersion"], "sdk": info.get("DTSDKName"),
        "privacyManifest": "bundled", "localNetworkDescription": "bundled",
        "privacyAPIReview": api_review,
        "note": "產物內容檢查通過；不代表已完成簽章、實機測試或 Apple 審核",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path)
    parser.add_argument("--build-number")
    parser.add_argument("--require-store-sdk", action="store_true")
    parser.add_argument("--check-api-symbols", action="store_true", help="使用 Xcode nm 盤點 C API 匯入；正式 SDK 檢查會自動啟用")
    parser.add_argument("--require-declared-api", action="store_true", help="未宣告的 C API 類別視為錯誤，適用 Release 模擬器")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    version = json.loads((root / "package.json").read_text())["version"]
    try:
        print(json.dumps(verify(args.app, version, args.build_number, args.require_store_sdk, args.check_api_symbols, args.require_declared_api), ensure_ascii=False, indent=2))
    except (OSError, ValueError, KeyError, plistlib.InvalidFileException, subprocess.SubprocessError) as error:
        parser.exit(1, f"iOS 產物檢查失敗：{error}\n")
