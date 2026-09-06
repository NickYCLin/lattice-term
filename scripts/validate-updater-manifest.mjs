import fs from "node:fs";
import { pathToFileURL } from "node:url";

// Keep the generic keys for older installed clients as well as the bundle
// specific keys used by recent updater versions.
const REQUIRED_TARGETS = {
  "darwin-x86_64": "_x64.app.tar.gz",
  "darwin-x86_64-app": "_x64.app.tar.gz",
  "darwin-aarch64": "_aarch64.app.tar.gz",
  "darwin-aarch64-app": "_aarch64.app.tar.gz",
  "linux-x86_64": "_amd64.AppImage",
  "linux-aarch64": "_aarch64.AppImage",
  "windows-x86_64": "_x64-setup.exe",
};

export function validateUpdaterManifest(manifest, releaseData, tag) {
  const release = Array.isArray(releaseData)
    ? releaseData.find((entry) => entry.tag_name === tag)
    : releaseData;
  if (!/^v\d+\.\d+\.\d+$/.test(tag) ||
      manifest?.version !== tag.slice(1) || release?.tag_name !== tag) {
    throw new Error("更新清單、Release 與預期標籤的版本不一致");
  }
  const platforms = manifest.platforms;
  if (!platforms || typeof platforms !== "object" || Array.isArray(platforms)) {
    throw new Error("更新清單缺少平台資料");
  }
  const assets = release.assets;
  if (!Array.isArray(assets)) throw new Error("Release 缺少資產清單");

  for (const target of Object.keys(REQUIRED_TARGETS)) {
    if (!platforms[target]) throw new Error(`更新清單缺少必要平台：${target}`);
  }

  for (const [target, platform] of Object.entries(platforms)) {
    if (typeof platform?.signature !== "string" || !platform.signature.trim()) {
      throw new Error(`${target} 缺少更新簽章`);
    }
    const asset = assets.find((entry) =>
      typeof platform.url === "string" && platform.url.startsWith("https://") &&
      (entry.url === platform.url || entry.browser_download_url === platform.url),
    );
    if (!asset || asset.state !== "uploaded" || !(asset.size > 0)) {
      throw new Error(`${target} 的更新包尚未完整上傳至此 Release`);
    }
    const suffix = REQUIRED_TARGETS[target];
    if (suffix && asset.name !== `LatticeTerm_${manifest.version}${suffix}`) {
      throw new Error(`${target} 的更新包版本、架構或格式不符：${asset.name}`);
    }
    if (!assets.some((entry) => entry.name === `${asset.name}.sig` &&
        entry.state === "uploaded" && entry.size > 0)) {
      throw new Error(`${target} 缺少已上傳的簽章檔`);
    }
  }
}

function main() {
  const [, , manifestPath, releasePath, tag] = process.argv;
  if (!manifestPath || !releasePath || !tag) {
    throw new Error("用法：node scripts/validate-updater-manifest.mjs <latest.json> <release.json> <tag>");
  }
  validateUpdaterManifest(
    JSON.parse(fs.readFileSync(manifestPath, "utf8")),
    JSON.parse(fs.readFileSync(releasePath, "utf8")),
    tag,
  );
  console.log(`已確認 ${tag} 的桌面更新平台、架構、上傳資產與簽章檔齊全。`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
