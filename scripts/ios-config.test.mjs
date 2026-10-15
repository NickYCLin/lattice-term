import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
