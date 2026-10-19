import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("iOS workflow 驗證邊界", () => {
  const workflow = parse(readFileSync(new URL("../.github/workflows/ios-verify.yml", import.meta.url), "utf8"));
  const build = workflow.jobs.simulator;
  const native = workflow.jobs["native-interactions"];

  it("保留 push 與 PR 建置，三機互動只接受手動明確勾選", () => {
    expect(workflow.on.push.branches).toEqual(["main"]);
    expect(workflow.on.pull_request.paths).toContain("src-tauri/**");
    expect(workflow.on.workflow_dispatch.inputs.native_interactions).toMatchObject({ type: "boolean", default: false });
    expect(native.if).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.native_interactions }}");
    expect(native.needs).toBe("simulator");
  });

  it("日常建置仍檢查 bundle 並封裝實機，不啟動模擬器互動", () => {
    const commands = build.steps.map((step) => step.run ?? "").join("\n");
    expect(commands).toContain("npm run ios:check");
    expect(commands).toContain("npm run ios:simulator:release");
    expect(commands).toContain("npm run ios:device:unsigned");
    expect(commands).toContain("--require-store-sdk");
    expect(commands).not.toContain("scripts/ios-simulator-smoke.py");
    expect(commands).not.toContain("defaults write");
  });

  it("互動下載同輪同 SHA 的封裝並驗證來源、架構及雜湊後才解壓縮", () => {
    const upload = build.steps.find((step) => step.with?.name === "ios-native-simulator-${{ github.sha }}");
    expect(upload.if).toBe(native.if);
    expect(upload.with.path).toContain("reports/ios-simulator.tar.gz");
    expect(upload.with.path).toContain("reports/provenance.json");
    const download = native.steps.find((step) => step.name === "Download this run's simulator bundle");
    expect(download.run).toContain('gh run download "$GITHUB_RUN_ID"');
    expect(download.run).toContain('ios-native-simulator-${GITHUB_SHA}');
    const verify = native.steps.find((step) => step.name === "Verify simulator source and extract safely").run;
    for (const field of ["GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "platform.machine()", "verify_archive", "extract_app"])
      expect(verify).toContain(field);
    expect(verify.indexOf("reuse.verify_archive(")).toBeLessThan(verify.indexOf("reuse.extract_app("));
  });

  it("保留真互動參數、失敗狀態與原始證據", () => {
    const capture = native.steps.find((step) => step.name === "Capture isolated simulator layout evidence");
    expect(capture.run).toContain("--store-screenshots --layout-diagnostics --interaction-checks");
    expect(native["timeout-minutes"]).toBe(60);
    for (const job of Object.values(workflow.jobs)) {
      expect(job["continue-on-error"]).toBeUndefined();
      for (const step of job.steps) expect(step["continue-on-error"]).toBeUndefined();
    }
    for (const name of ["ios-layout-evidence", "ios-simulator-launch-evidence"]) {
      expect(native.steps.find((step) => step.with?.name === name).if).toBe("always()");
    }
  });

  it("建置摘要明示未驗互動，下載權限僅限互動 job", () => {
    expect(build.steps.find((step) => step.name === "Report verification boundaries").run).toContain("未代表原生互動通過");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(native.permissions).toEqual({ contents: "read", actions: "read" });
  });

  it("所有 shell 與內嵌 Python 指令語法有效", () => {
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps.filter((entry) => entry.run)) {
        const shell = spawnSync("bash", ["-n"], { input: step.run, encoding: "utf8" });
        expect(shell.status, shell.stderr).toBe(0);
        for (const match of step.run.matchAll(/python3 - <<'PY'\n([^]*?)\nPY/g)) {
          const python = spawnSync("python3", ["-c", "import sys; compile(sys.stdin.read(), '<workflow>', 'exec')"], { input: match[1], encoding: "utf8" });
          expect(python.status, python.stderr).toBe(0);
        }
      }
    }
  });

  it("實際來源檢查指令接受同輪封裝並拒絕異動雜湊", () => {
    const command = native.steps.find((step) => step.name === "Verify simulator source and extract safely").run;
    const code = command.match(/python3 - <<'PY'\n([^]*?)\nPY/)[1];
    const fixture = `
import hashlib, io, json, os, shutil, tarfile, tempfile
from pathlib import Path
from unittest.mock import patch
source = Path('scripts/reuse-ios-simulator.py').resolve()
code = ${JSON.stringify(code)}
for corrupt in (False, True):
    with tempfile.TemporaryDirectory() as temporary:
        previous = Path.cwd()
        try:
            os.chdir(temporary)
            Path('scripts').mkdir()
            shutil.copyfile(source, 'scripts/reuse-ios-simulator.py')
            package = Path('native-source/package')
            package.mkdir(parents=True)
            archive = package / 'ios-simulator.tar.gz'
            with tarfile.open(archive, 'w:gz') as output:
                member = tarfile.TarInfo('LatticeTerm.app/Info.plist')
                member.size = 7
                output.addfile(member, io.BytesIO(b'fixture'))
            import platform
            provenance = {'commit': 'a' * 40, 'runId': '42', 'runAttempt': '1',
                          'simulatorArchitecture': platform.machine(),
                          'sha256': {archive.name: '0' * 64 if corrupt else hashlib.sha256(archive.read_bytes()).hexdigest()}}
            (package / 'provenance.json').write_text(json.dumps(provenance))
            with patch.dict(os.environ, {'GITHUB_SHA': 'a' * 40, 'GITHUB_RUN_ID': '42', 'GITHUB_RUN_ATTEMPT': '1'}), patch('subprocess.run') as verify:
                if corrupt:
                    try:
                        exec(code, {})
                        raise AssertionError('corrupt archive accepted')
                    except ValueError:
                        pass
                    verify.assert_not_called()
                    assert not Path('native-source/extracted').exists()
                else:
                    exec(code, {})
                    verify.assert_called_once()
                    assert verify.call_args.kwargs['check'] is True
                    assert Path('native-source/extracted/LatticeTerm.app/Info.plist').read_bytes() == b'fixture'
        finally:
            os.chdir(previous)
`;
    const result = spawnSync("python3", ["-c", fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });
});

describe("iOS Tauri 設定", () => {
  it("iOS 前端掛載後要求原生 layout，不改 frame 或安全區", () => {
    const app = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
    const hook = app.split('fn mobile_frontend_ready')[1].split('/// Probing')[0];
    expect(hook).toContain('#[cfg(target_os = "ios")]');
    expect(hook).toContain("view.setNeedsLayout()");
    expect(hook).toContain("view.layoutIfNeeded()");
    expect(hook).not.toMatch(/setFrame|contentInset|evaluateJavaScript/);
    expect(app.split('tauri::generate_handler![')[1]).toContain("mobile_frontend_ready,");
  });

  it("行動版不啟動桌面 bridge，client 也拒絕自啟背景服務", () => {
    const app = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
    const client = readFileSync(new URL("../src-tauri/src/agent_daemon/client.rs", import.meta.url), "utf8");
    expect(app).toMatch(/#\[cfg\(desktop\)\]\s*agent_daemon::client::start_desktop_bridge/);
    expect(client).toMatch(/pub async fn ensure[^]*?require_desktop_daemon\(cfg!\(desktop\)\)\?;/);
    expect(client).toMatch(/#\[cfg\(not\(desktop\)\)\]\s*pub\(super\) fn spawn_daemon[^]*?require_desktop_daemon\(false\)/);
    expect(client).toMatch(/#\[cfg\(desktop\)\]\s*pub\(super\) fn spawn_daemon/);
  });

  it("商店匯出不含過期的企業團隊或 In-House 描述檔", () => {
    const source = readFileSync(new URL("../src-tauri/gen/apple/ExportOptions.plist", import.meta.url), "utf8");
    expect(source).toContain("<string>app-store-connect</string>");
    expect(source).toContain("<string>export</string>");
    expect(source).not.toMatch(/enterprise|InHouse_|SQDAQK66UY|tw\.nickyclin|<key>teamID<\/key>/);
  });

  it("區域網路用途由 Tauri 合併，且隱私清單實際加入資源階段", () => {
    const info = readFileSync(new URL("../src-tauri/Info.ios.plist", import.meta.url), "utf8");
    const project = readFileSync(new URL("../src-tauri/gen/apple/lattice-term.xcodeproj/project.pbxproj", import.meta.url), "utf8");
    const privacy = readFileSync(new URL("../src-tauri/gen/apple/lattice-term_iOS/PrivacyInfo.xcprivacy", import.meta.url), "utf8");
    expect(info).toContain("NSLocalNetworkUsageDescription");
    expect(info).toMatch(/<key>UIFileSharingEnabled<\/key>\s*<true\/>/);
    expect(info).toMatch(/<key>LSSupportsOpeningDocumentsInPlace<\/key>\s*<true\/>/);
    expect(info).not.toContain("NSAllowsArbitraryLoads");
    // SSH uses bundled cryptography. Exemption must be assessed separately,
    // rather than declaring all encryption exempt just to bypass Apple's form.
    expect(info).not.toContain("ITSAppUsesNonExemptEncryption");
    const resources = project.split("/* Begin PBXResourcesBuildPhase section */")[1].split("/* End PBXResourcesBuildPhase section */")[0];
    expect(resources).toContain("PrivacyInfo.xcprivacy in Resources");
    expect(privacy).toContain("NSPrivacyAccessedAPICategoryFileTimestamp");
    expect(privacy).toContain("NSPrivacyAccessedAPICategorySystemBootTime");
    expect(privacy).toMatch(/<key>NSPrivacyTracking<\/key>\s*<false\/>/);
  });

  it("iOS 沿用個人識別且不硬編碼開發團隊", () => {
    const desktopConfig = JSON.parse(
      readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
    );
    const iosConfig = JSON.parse(
      readFileSync(
        new URL("../src-tauri/tauri.ios.conf.json", import.meta.url),
        "utf8",
      ),
    );

    expect(desktopConfig.identifier).toBe("io.github.nickyclin.latticeterm");
    expect(desktopConfig.bundle.iOS).toBeUndefined();
    expect(iosConfig.identifier).toBe("io.github.nickyclin.latticeterm");
    expect(iosConfig.bundle.iOS.developmentTeam).toBeUndefined();
    expect(iosConfig.bundle.iOS.infoPlist).toBe("Info.ios.plist");
    expect(iosConfig.bundle.iOS.bundleVersion).toBe("1");
  });

  it("Apple/Xcode 專案使用個人自動簽章設定", () => {
    const projectDefinition = readFileSync(
      new URL("../src-tauri/gen/apple/project.yml", import.meta.url),
      "utf8",
    );
    const xcodeProject = readFileSync(
      new URL(
        "../src-tauri/gen/apple/lattice-term.xcodeproj/project.pbxproj",
        import.meta.url,
      ),
      "utf8",
    );

    for (const source of [projectDefinition, xcodeProject]) {
      expect(source).toContain("io.github.nickyclin.latticeterm");
      expect(source).not.toContain("tw.nickyclin.latticeterm");
      expect(source).not.toContain("SQDAQK66UY");
      expect(source).not.toContain("InHouse_nickyclinLatticeterm_2026_09_03");
    }

    expect(projectDefinition).toContain('CODE_SIGN_IDENTITY: "Apple Development"');
    expect(projectDefinition).toContain("CODE_SIGN_STYLE: Automatic");
    expect(xcodeProject).toContain('CODE_SIGN_IDENTITY = "Apple Development";');
    expect(xcodeProject).toContain("CODE_SIGN_STYLE = Automatic;");
    expect(projectDefinition).not.toContain("- path: Externals");
  });

  it("iOS 實機維持 arm64，模擬器則使用 Xcode 的主機相容架構", () => {
    const projectDefinition = readFileSync(
      new URL("../src-tauri/gen/apple/project.yml", import.meta.url),
      "utf8",
    );
    const xcodeProject = readFileSync(
      new URL(
        "../src-tauri/gen/apple/lattice-term.xcodeproj/project.pbxproj",
        import.meta.url,
      ),
      "utf8",
    );

    for (const source of [projectDefinition, xcodeProject]) {
      expect(source).toContain("ARCHS[sdk=iphoneos*]");
      expect(source).not.toMatch(/\bVALID_ARCHS\b/);
    }
  });

  it("不將桌面 sidecar 納入 iOS bundle", () => {
    const config = JSON.parse(
      readFileSync(new URL("../src-tauri/tauri.ios.conf.json", import.meta.url), "utf8"),
    );

    expect(config.bundle.externalBin).toEqual([]);
  });

  it("啟用 iOS Keychain 的 protected feature", () => {
    const cargoManifest = readFileSync(
      new URL("../src-tauri/Cargo.toml", import.meta.url),
      "utf8",
    );

    expect(cargoManifest).toContain(
      'apple-native-keyring-store = { version = "1.0.2", features = ["protected"] }',
    );
  });
});
