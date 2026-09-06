import { describe, expect, it } from "vitest";

import { validateUpdaterManifest } from "./validate-updater-manifest.mjs";

function fixture() {
  const release = { tag_name: "v1.0.2", assets: [] };
  const manifest = { version: "1.0.2", platforms: {} };
  const bundles = [
    [["darwin-x86_64", "darwin-x86_64-app"], "_x64.app.tar.gz"],
    [["darwin-aarch64", "darwin-aarch64-app"], "_aarch64.app.tar.gz"],
    [["linux-x86_64"], "_amd64.AppImage"],
    [["linux-aarch64"], "_aarch64.AppImage"],
    [["windows-x86_64"], "_x64-setup.exe"],
  ];
  for (const [targets, suffix] of bundles) {
    const name = `LatticeTerm_1.0.2${suffix}`;
    const url = `https://api.github.com/repos/NickYCLin/lattice-term/releases/assets/${release.assets.length + 1}`;
    const browserUrl = `https://github.com/NickYCLin/lattice-term/releases/download/v1.0.2/${name}`;
    release.assets.push(
      { name, url, browser_download_url: browserUrl, state: "uploaded", size: 100 },
      { name: `${name}.sig`, state: "uploaded", size: 10 },
    );
    for (const target of targets) manifest.platforms[target] = { url, signature: "signed" };
  }
  return { manifest, release };
}

describe("validateUpdaterManifest", () => {
  it("從包含已發布版本的清單選取指定草稿 Release", () => {
    const { manifest, release } = fixture();
    release.draft = true;
    const releases = [{ tag_name: "v1.0.1", draft: false, assets: [] }, release];
    expect(() => validateUpdaterManifest(manifest, releases, "v1.0.2")).not.toThrow();
    expect(() => validateUpdaterManifest(manifest, releases.slice(0, 1), "v1.0.2")).toThrow("版本不一致");
  });

  it("接受各平台已上傳的更新包與簽章檔", () => {
    const { manifest, release } = fixture();
    expect(() => validateUpdaterManifest(manifest, release, "v1.0.2")).not.toThrow();
    manifest.platforms["darwin-x86_64"].url = release.assets[0].browser_download_url;
    expect(() => validateUpdaterManifest(manifest, release, "v1.0.2")).not.toThrow();
  });

  it.each(["darwin-x86_64", "darwin-x86_64-app", "darwin-aarch64", "linux-x86_64", "linux-aarch64", "windows-x86_64"])(
    "阻擋漏掉 %s 的 Release，包含舊版 Intel 客戶端的查詢鍵",
    (target) => {
      const { manifest, release } = fixture();
      delete manifest.platforms[target];
      expect(() => validateUpdaterManifest(manifest, release, "v1.0.2")).toThrow(`缺少必要平台：${target}`);
    },
  );

  it("拒絕將 Apple Silicon 更新包誤列為 Intel 更新包", () => {
    const { manifest, release } = fixture();
    manifest.platforms["darwin-x86_64"] = manifest.platforms["darwin-aarch64"];
    expect(() => validateUpdaterManifest(manifest, release, "v1.0.2")).toThrow("架構或格式不符");
  });

  it.each(["version", "release", "missing-asset", "uploading", "empty", "signature", "signature-file"])(
    "阻擋不完整或錯版的發布資料：%s",
    (fault) => {
      const { manifest, release } = fixture();
      if (fault === "version") manifest.version = "1.0.1";
      if (fault === "release") release.tag_name = "v1.0.1";
      if (fault === "missing-asset") release.assets.shift();
      if (fault === "uploading") release.assets[0].state = "starter";
      if (fault === "empty") release.assets[0].size = 0;
      if (fault === "signature") manifest.platforms["darwin-x86_64"].signature = " ";
      if (fault === "signature-file") release.assets.splice(1, 1);
      expect(() => validateUpdaterManifest(manifest, release, "v1.0.2")).toThrow();
    },
  );
});
