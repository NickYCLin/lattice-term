import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppUpdater } from "../../app/useAppUpdater";
import { I18nProvider } from "../../i18n";
import { UpdatePrompt } from "./UpdatePrompt";

const NOTES = [
  "## 🚀 新增功能",
  "",
  "- **files**：支援遠端純文字線上編輯 ([#187](https://github.com/o/r/issues/187)) ([4b7f7e8](https://github.com/o/r/commit/4b7f7e829523bcc1b9bb53e6db158a8b368a18ce)), closes [#186](https://github.com/o/r/issues/186)",
].join("\n");

function render(releaseNotes: string | null) {
  const updater = {
    status: "available",
    currentVersion: "2.0.0",
    availableVersion: "2.1.0",
    releaseDate: null,
    releaseNotes,
    downloadedBytes: 0,
    totalBytes: 0,
    progressPercent: 0,
    error: null,
    lastChecked: null,
    checkForUpdates: vi.fn(),
    downloadAndInstall: vi.fn(),
    restartNow: vi.fn(),
  } as unknown as AppUpdater;

  return renderToStaticMarkup(
    <I18nProvider locale="zh-TW">
      <UpdatePrompt updater={updater} onDismiss={vi.fn()} />
    </I18nProvider>,
  );
}

describe("UpdatePrompt", () => {
  it("shows the release notes as sentences, not as Markdown", () => {
    const markup = render(NOTES);

    expect(markup).toContain("🚀 新增功能");
    expect(markup).toContain("files：支援遠端純文字線上編輯 (#187), closes #186");
    // No leftover markup or commit URLs for a person to read past.
    expect(markup).not.toContain("**");
    expect(markup).not.toContain("](");
    expect(markup).not.toContain("/commit/");
    expect(markup).not.toContain("## ");
  });

  it("keeps unusual notes visible rather than showing an empty box", () => {
    expect(render("純文字說明，沒有任何標記。")).toContain(
      "純文字說明，沒有任何標記。",
    );
    expect(render(null)).not.toContain("release-notes");
  });
});
