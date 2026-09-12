import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { defaultPreferences } from "../app/preferences";
import type { AppUpdater } from "../app/useAppUpdater";
import type { RuntimeState } from "../app/useRuntimeSummary";
import type { StorageState } from "../app/useStorageStatus";
import { I18nProvider } from "../i18n";
import { SettingsView } from "./SettingsView";

const updater: AppUpdater = {
  status: "idle",
  currentVersion: "0.28.0",
  availableVersion: null,
  releaseDate: null,
  releaseNotes: null,
  downloadedBytes: 0,
  totalBytes: 0,
  progressPercent: 0,
  error: null,
  lastChecked: null,
  checkForUpdates: vi.fn(() => Promise.resolve()),
  downloadAndInstall: vi.fn(() => Promise.resolve()),
  relaunchApp: vi.fn(() => Promise.resolve()),
};

const storage: StorageState = {
  status: { path: "/tmp/latticeterm", profileCount: 0 },
  mode: "persistent",
  refresh: vi.fn(),
};

function renderSettings(platform: string): string {
  const runtime: RuntimeState = {
    host: "tauri",
    summary: {
      appName: "LatticeTerm",
      version: "0.28.0",
      supportedProtocols: [],
      credentialStorageReady: true,
      platform,
    },
  };
  return renderToStaticMarkup(
    <I18nProvider locale="zh-TW">
      <SettingsView
        preferences={defaultPreferences}
        onChange={vi.fn()}
        runtime={runtime}
        storage={storage}
        vaultUnlocked={false}
        onBackupRestored={vi.fn(() => Promise.resolve())}
        updater={updater}
      />
    </I18nProvider>,
  );
}

describe("Settings updater platform boundary", () => {
  it("directs iOS users to their Apple installation channel", () => {
    const markup = renderSettings("ios");

    expect(markup).toContain("透過原安裝來源更新");
    expect(markup).toContain("TestFlight");
    expect(markup).toContain("App Store");
    expect(markup).toContain("iPhone／iPad App");
    expect(markup).not.toContain("拿手機相機掃這個 QR");
    expect(markup).toContain("閱讀資料使用與隱私權說明");
    expect(markup).toContain("不內建廣告、使用分析或跨 App 追蹤");
    expect(markup).not.toContain("GitHub Releases");
    expect(markup).not.toContain("請在桌面應用程式檢查與安裝更新");
    expect(markup).not.toContain("啟動時檢查更新");
    expect(markup).not.toMatch(/<button[^>]*>檢查更新<\/button>/);
  });

  it("does not offer the unregistered updater plugin on Android", () => {
    const markup = renderSettings("android");

    expect(markup).toContain("請在桌面應用程式檢查與安裝更新");
    expect(markup).not.toContain("啟動時檢查更新");
    expect(markup).not.toMatch(/<button[^>]*>檢查更新<\/button>/);
  });

  it("keeps updater controls available in a desktop Tauri build", () => {
    const markup = renderSettings("linux");

    expect(markup).toContain("啟動時檢查更新");
    expect(markup).toMatch(/<button[^>]*>檢查更新<\/button>/);
    expect(markup).not.toContain("請在桌面應用程式檢查與安裝更新");
  });
  it("offers twelve new previews, independent event sounds and volume", () => {
    const markup = renderSettings("linux");
    for (const label of ["柔和", "清亮", "自然", "電子", "綻放", "微風", "月光", "水滴", "玻璃鈴", "星點", "木琴", "撥弦", "竹響", "軌道", "脈衝", "像素", "霧藍"]) expect(markup).toContain(label);
    expect(markup).toContain('id="sound-agentCompletionSound"');
    expect(markup).toContain('id="sound-chatCompletionSound"');
    expect(markup).toContain('id="notification-volume"');
    expect(markup.match(/class="sound-cue"/g)).toHaveLength(12);
    expect(markup).not.toContain("白瓷");
    expect(markup).not.toContain('value="clear"');
  });

});
