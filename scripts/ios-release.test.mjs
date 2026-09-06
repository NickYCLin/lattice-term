import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiSigningProblems, manualSigningProblems, environmentProblems, preserveSimulatorOutput, releaseArguments, releaseConfig, simulatorArguments, simulatorXcodebuildScript, synchronizeNativeVersions, unsignedDeviceArguments } from "./ios-release.mjs";

describe("iOS 發布準備", () => {
  it.each([["x64", "x86_64"], ["arm64", "arm64-sim"]])("重建 %s 模擬器時保留舊 App，讓新版可搬入", (architecture, target) => {
    const directory = mkdtempSync(join(tmpdir(), "ios-previous-"));
    try {
      const app = join(directory, "build", target, "LatticeTerm.app");
      expect(preserveSimulatorOutput(directory, architecture)).toBeUndefined();
      mkdirSync(app, { recursive: true });
      writeFileSync(join(app, "previous.txt"), "previous working app");
      const previous = preserveSimulatorOutput(directory, architecture);
      expect(readFileSync(join(previous, "previous.txt"), "utf8")).toBe("previous working app");
      expect(existsSync(app)).toBe(false);
      // A subsequent build can publish its app without touching the backup.
      mkdirSync(app);
      writeFileSync(join(app, "current.txt"), "new app");
      const second = preserveSimulatorOutput(directory, architecture);
      expect(second).not.toBe(previous);
      expect(readFileSync(join(second, "current.txt"), "utf8")).toBe("new app");
      expect(readFileSync(join(previous, "previous.txt"), "utf8")).toBe("previous working app");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === "win32")("拒絕沿著符號連結移動外部 Simulator 產物", () => {
    const directory = mkdtempSync(join(tmpdir(), "ios-linked-output-"));
    try {
      const external = join(directory, "external");
      mkdirSync(external);
      writeFileSync(join(external, "keep.txt"), "keep external contents");
      for (const relative of ["build", "build/x86_64", "build/x86_64/LatticeTerm.app", ".release"]) {
        const appleDirectory = mkdtempSync(join(directory, "apple-"));
        const linked = join(appleDirectory, relative);
        mkdirSync(join(linked, ".."), { recursive: true });
        symlinkSync(external, linked);
        expect(() => preserveSimulatorOutput(appleDirectory, "x64")).toThrow("符號連結");
        expect(readFileSync(join(external, "keep.txt"), "utf8")).toBe("keep external contents");
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("不將未知架構或同名一般檔案當成可移動的 App", () => {
    const directory = mkdtempSync(join(tmpdir(), "ios-invalid-output-"));
    try {
      expect(() => preserveSimulatorOutput(directory, "unknown")).toThrow("架構");
      mkdirSync(join(directory, "build/x86_64"), { recursive: true });
      const file = join(directory, "build/x86_64/LatticeTerm.app");
      writeFileSync(file, "keep existing file");
      expect(() => preserveSimulatorOutput(directory, "x64")).toThrow("一般目錄");
      expect(readFileSync(file, "utf8")).toBe("keep existing file");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("CI 的手動簽章輸入可取代本機憑證，但不能缺少任何一項", () => {
    const manual = { certificate: Buffer.from("PKCS12 fixture").toString("base64"), password: "", profile: Buffer.from("CMS fixture").toString("base64") };
    expect(environmentProblems({ platform: "darwin", xcode: "Xcode 26.3", sdk: "26.2", team: "ABCDEFGHIJ", identities: "0 valid identities found", manual })).toEqual([]);
    for (const field of Object.keys(manual)) expect(manualSigningProblems({ ...manual, [field]: undefined })).toHaveLength(1);
    expect(manualSigningProblems({ ...manual, certificate: "secret-not-base64" }).join()).not.toContain("secret-not-base64");
    expect(manualSigningProblems({ ...manual, profile: "a==" })).toHaveLength(1);
  });
  it("CI 可使用有效 API 金鑰交由 Xcode 簽章，拒絕不完整或錯誤輸入且不洩漏內容", () => {
    const directory = mkdtempSync(join(tmpdir(), "ios-api-"));
    try {
      const path = join(directory, "AuthKey.p8");
      const api = { key: "ABCDEFGHIJ", issuer: "11111111-2222-3333-4444-555555555555", path };
      const environment = { platform: "darwin", xcode: "Xcode 26.3", sdk: "26.2", team: "ABCDEFGHIJ", identities: "0 valid identities found", api };
      expect(apiSigningProblems(api)).toHaveLength(1);
      writeFileSync(path, "sensitive-but-invalid-private-key");
      expect(apiSigningProblems(api).join()).not.toContain("sensitive-but-invalid");
      const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }));
      expect(environmentProblems(environment)).toEqual([]);
      expect(apiSigningProblems({ ...api, issuer: undefined })).toHaveLength(1);
      expect(apiSigningProblems({ ...api, key: "../key" })).toHaveLength(1);
      expect(apiSigningProblems({ ...api, path: directory })).toHaveLength(1);
      expect(environmentProblems({ ...environment, api: {} })).toHaveLength(3);
      const other = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
      writeFileSync(path, other.privateKey.export({ type: "pkcs8", format: "pem" }));
      expect(apiSigningProblems(api)).toHaveLength(1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it.skipIf(process.platform === "win32")("只對模擬器建置指定 SDK，且原樣傳遞含空白的路徑", () => {
    const directory = mkdtempSync(join(tmpdir(), "ios-xcode-"));
    try {
      const realTool = join(directory, "Xcode's real tool");
      const wrapper = join(directory, "xcodebuild");
      writeFileSync(realTool, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
      writeFileSync(wrapper, simulatorXcodebuildScript(realTool, "arm64"), { mode: 0o755 });
      const run = (args) => execFileSync(wrapper, args, { encoding: "utf8" }).trim().split("\n");
      expect(run(["-version"])).toEqual(["-version"]);
      expect(run(["archive", "-archivePath", "/a path/archive"])).toEqual([
        "archive", "-archivePath", "/a path/archive", "-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator", "ARCHS=arm64",
      ]);
      const explicit = ["archive", "-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator", "ARCHS=arm64"];
      expect(run(explicit)).toEqual(explicit);
      expect(run(["archive", "-sdk", "iphoneos", "-destination", "generic/platform=iOS"])).toEqual(explicit);
      expect(run(["archive", "-arch", "x86_64", "ARCHS=arm64 x86_64"])).toEqual(explicit);
      writeFileSync(wrapper, simulatorXcodebuildScript(realTool, "x64"), { mode: 0o755 });
      expect(run(["archive"]).at(-1)).toBe("ARCHS=x86_64");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);
  it("Intel 與 Apple silicon 模擬器都不使用實機 target 或簽章", () => {
    expect(simulatorArguments("config.json", "x64")).toContain("x86_64");
    expect(simulatorArguments("config.json", "arm64")).toContain("aarch64-sim");
    expect(simulatorArguments("config.json", "arm64")).toContain("--no-sign");
    expect(simulatorArguments("config.json", "arm64")).not.toContain("aarch64");
    expect(() => simulatorArguments("config.json", "unknown")).toThrow();
  });
  it("最佳化模擬器使用 Release 並保留無簽章邊界", () => {
    const args = simulatorArguments("config.json", "arm64", true);
    expect(args).not.toContain("--debug");
    expect(args).toContain("--no-sign");
    expect(args).toContain("aarch64-sim");
    expect(simulatorArguments("config.json", "arm64")).toContain("--debug");
    expect(() => simulatorXcodebuildScript("/xcodebuild", "unknown")).toThrow();
  });
  it("無簽章實機驗證只建立 Release archive，不匯出商店 IPA", () => {
    const args = unsignedDeviceArguments("/a path/config.json");
    expect(args).toContain("aarch64");
    expect(args).toContain("--no-sign");
    expect(args).toContain("--archive-only");
    expect(args).not.toContain("--debug");
    expect(args).not.toContain("--export-method");
    expect(args.at(-1)).toBe("/a path/config.json");
  });
  it("同一行銷版本可以產生不同建置號，且不帶入帳號資料", () => {
    expect(releaseConfig("0.45.0", "2")).toEqual({ version: "0.45.0", bundle: { iOS: { bundleVersion: "2" } } });
    expect(releaseConfig("0.45.0", "3").bundle.iOS.bundleVersion).toBe("3");
    expect(releaseConfig("1.0.0", "9999.99.99").bundle.iOS.bundleVersion).toBe("9999.99.99");
  });
  it.each([undefined, "", "0", "01", "10000", "1.100", "1.1.100", "1.2.3.4", "1;echo secret", "1beta"]) (
    "拒絕 Apple 不接受的建置號 %s", (number) => expect(() => releaseConfig("1.0.0", number)).toThrow(),
  );
  it.each(["1.0.0-beta", "v1.0.0", "1.0", "01.0.0"]) (
    "拒絕不適用 App Store 的版本 %s", (version) => expect(() => releaseConfig(version, "1")).toThrow(),
  );
  it("TestFlight 與商店均使用 App Store Connect 的實機匯出方式", () => {
    const args = releaseArguments("/a path/config.json");
    expect(args).toContain("app-store-connect");
    expect(args).toContain("aarch64");
    expect(args.at(-1)).toBe("/a path/config.json");
    expect(args).not.toContain("release-testing");
    expect(args).not.toContain("--build-number");
    expect(args).not.toContain("--no-sign");
  });
  it("列出舊 SDK、團隊與憑證缺項而不宣稱已可送審", () => {
    const problems = environmentProblems({ platform: "darwin", xcode: "Xcode 16.4", sdk: "18.5", team: undefined, identities: "0 valid identities found" });
    expect(problems).toHaveLength(4);
    expect(problems.join("\n")).toContain("Xcode 26");
  });
  it("接受新 SDK 與自動簽章的開發憑證", () => {
    expect(environmentProblems({ platform: "darwin", xcode: "Xcode 26.1\nBuild version 17B", sdk: "26.1", team: "ABCDEFGHIJ", identities: '1) hash "Apple Development: Example (ABCDEFGHIJ)"' })).toEqual([]);
  });
  it("同步過期的原生版本時保留其他 plist 欄位", () => {
    const source = '<key>CFBundleShortVersionString</key>\n<string>0.36.0</string>\n<key>CFBundleVersion</key>\n<string>0.36.0</string>\n<key>Other</key><true/>';
    const result = synchronizeNativeVersions('CFBundleShortVersionString: 0.34.0\nCFBundleVersion: "0.34.0"', source, "0.45.0");
    expect(result.project).not.toContain("0.34.0");
    expect(result.plist).not.toContain("0.36.0");
    expect(result.plist).toContain("<key>Other</key><true/>");
    expect(result.plist).toContain("<string>0.45.0</string>");
    expect(result.plist).toContain("<string>1</string>");
    expect(result.project).toContain('CFBundleVersion: "1"');
  });
  it("原生結構改變時停止，避免只同步部分欄位", () => {
    expect(() => synchronizeNativeVersions("missing", "missing", "1.0.0")).toThrow();
  });
});
