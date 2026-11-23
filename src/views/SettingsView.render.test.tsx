import { zhTW } from "../i18n/messages/zh-TW";
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

function renderSettings(platform: string, update: Partial<AppUpdater> = {}): string {
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
        updater={{ ...updater, ...update }}
      />
    </I18nProvider>,
  );
}

describe("Settings updater platform boundary", () => {
  it("offers an on-demand disk scan on Windows", () => {
    expect(renderSettings("windows")).toContain(zhTW["settings.sandbox.control"]);
    expect(renderSettings("linux")).not.toContain(zhTW["settings.sandbox.control"]);
    expect(renderSettings("windows")).toContain(zhTW["disk.scan"]);
    expect(renderSettings("linux")).not.toContain(zhTW["disk.scan"]);
    expect(renderSettings("android")).not.toContain(zhTW["disk.scan"]);
  });
  it("offers independent labelled text sizes, output preview and reset", () => {
    const markup = renderSettings("windows");
    expect(markup).toContain("介面字級");
    expect(markup).toContain("輸出字級");
    expect(markup).toContain("不會中斷連線或清除紀錄");
    expect(markup).toContain('for="interface-text-scale"');
    expect(markup).toContain('for="output-font-size"');
    expect(markup).toContain('aria-valuetext="100%"');
    expect(markup).toContain('aria-valuetext="13 px"');
    expect(markup).toContain("恢復預設字級");
  });
  it("shows Windows desktop startup separately from the background service", () => {
    const markup = renderSettings("windows");
    expect(markup).toContain("登入 Windows 後自動開啟 LatticeTerm");
    expect(markup).toContain("與背景服務的登入啟動各自獨立");
    expect(renderSettings("ios")).not.toContain("登入 Windows 後自動開啟 LatticeTerm");
    expect(renderSettings("linux")).not.toContain("登入 Windows 後自動開啟 LatticeTerm");
  });
  it("shows the common languages as a labelled selection grid", () => {
    const markup = renderSettings("linux");

    for (const language of [
      "繁體中文",
      "简体中文",
      "English",
      "日本語",
      "한국어",
      "Español",
      "Français",
      "Deutsch",
    ]) {
      expect(markup).toContain(language);
    }
    expect(markup).toContain('class="language-grid"');
    expect(markup).toContain("尚未提供所選語言的文字會顯示英文");
  });

  it("keeps the iOS installation channel title without its explanatory tutorial", () => {
    const markup = renderSettings("ios");

    expect(markup).toContain("透過原安裝來源更新");
    expect(markup).not.toContain(zhTW["settings.updater.iosHint"]);
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

  it("shows the update check as a primary action above the other update settings", () => {
    const markup = renderSettings("linux");

    expect(markup).toMatch(/<div class="panel__actions"><button[^>]*class="button button--primary"[^>]*>檢查更新<\/button><\/div>/);
    expect(markup.indexOf("檢查更新<")).toBeLessThan(markup.indexOf("啟動時檢查更新"));
  });
  it("offers twelve new previews, independent event sounds and volume", () => {
    const markup = renderSettings("linux");
    for (const label of ["柔和", "清亮", "自然", "電子", "綻放", "微風", "月光", "水滴", "玻璃鈴", "星點", "木琴", "撥弦", "竹響", "軌道", "脈衝", "像素", "霧藍"]) expect(markup).toContain(label);
    expect(markup).toContain('id="sound-agentCompletionSound"');
    expect(markup).toContain('id="sound-chatCompletionSound"');
    expect(markup).toContain('id="notification-volume"');
    expect(markup).toMatch(/class="checkbox__box" aria-hidden="true"><svg\b/);
    expect(markup.match(/class="sound-cue"/g)).toHaveLength(12);
    expect(markup).not.toContain("白瓷");
    expect(markup).not.toContain('value="clear"');
  });

});

it.each([
  { status: "available" as const, stateText: "發現新版本 99.1.0", action: "下載並安裝更新", patch: { availableVersion: "99.1.0", releaseNotes: "Synthetic notes" } },
  { status: "downloaded" as const, stateText: "更新已安裝，請手動重新啟動完成套用", action: "重新啟動套用更新", patch: {} },
  { status: "checking" as const, stateText: "正在檢查更新...", action: "正在檢查更新...", patch: {} },
])("keeps a single update status and its action for $status", ({ status, stateText, action, patch }) => {
  const markup = renderSettings("linux", { status, ...patch });
  const section = markup.slice(markup.indexOf('>軟體更新</h2>'));
  // Count visible text only, excluding accessibility attributes and tooltips.
  const visible = section.replace(/<[^>]+>/g, " ");
  expect(visible.split(stateText)).toHaveLength(2);
  expect(section.split(`>${action}</button>`)).toHaveLength(2);
  if (status === "available") expect(section).toContain("Synthetic notes");
});

it.each(["ios", "android"])("hides local chat and memory settings on %s while keeping usable preferences", platform => {
  const html = renderSettings(platform);
  expect(html).not.toContain(">對話輸入</h2>");
  for (const label of ["送出快捷鍵", "進行中送出", "記憶與交接壓縮", "用 AI 摘要記憶"]) expect(html).not.toContain(label);
  for (const label of ["介面字級", "語言", "提示音音量", "加密備份"]) expect(html).toContain(label);
});
it.each(["linux", "macos"])("retains local chat and memory settings on %s", platform => {
  const html=renderSettings(platform);
  expect(html).toContain(">對話輸入</h2>");expect(html).toContain("記憶與交接壓縮");
  expect(html).toContain('class="setting-list setting-list--form"');
  expect(html).toMatch(/class="checkbox-row"><input type="checkbox"/);
});

it.each(["ios", "android"])("hides settings explanations on %s while retaining titles and controls", platform => {
  const mobile = renderSettings(platform), desktop = renderSettings("linux");
  for (const hint of ["interface-text-scale-hint", "output-font-size-hint"]) {
    expect(mobile).not.toContain(hint); expect(desktop).toContain(hint);
  }
  expect(mobile).not.toContain('class="theme-option__hint"');
  expect(desktop).toContain('class="theme-option__hint"');
  for (const text of ["介面字級", "輸出字級", "加密備份"]) expect(mobile).toContain(text);
});
