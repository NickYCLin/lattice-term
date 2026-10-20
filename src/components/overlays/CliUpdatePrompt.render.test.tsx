import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { CliUpdatePrompt } from "./CliUpdatePrompt";

it.each(["single", "batch", "checking"])("renders honest %s update progress", (mode) => {
  const html = renderToStaticMarkup(
    <I18nProvider locale="zh-TW">
      <CliUpdatePrompt updates={{
        items: [], busy: false, updating: mode === "single" ? "claude" : "all",
        progress: { activeId: mode === "checking" ? null : "claude", label: "Claude",
          completed: 1, total: 2, phase: mode === "checking" ? "checking" : "updating" },
        error: false, updateError: null, updated: [], visible: true,
        check: vi.fn(), dismiss: vi.fn(), updateCli: vi.fn(), updateAll: vi.fn(),
      }} />
    </I18nProvider>,
  );
  expect(html).toContain('<progress aria-labelledby="cli-update-progress-status"');
  expect(html).toContain(mode === "checking" ? "正在重新確認版本" : "正在更新 Claude");
  expect(html).toContain("更新程式未提供下載百分比");
  if (mode !== "single") {
    expect(html).toContain("已處理 1 / 2 項（包含失敗項目）");
    expect(html).toContain('value="1" max="2"');
  } else {
    expect(html).not.toContain("value=");
  }
});

it("distinguishes available, unknown and manually checked CLIs with direct update", () => {
  const html = renderToStaticMarkup(
    <I18nProvider locale="zh-TW">
      <CliUpdatePrompt updates={{
        items: [
          { id: "codex", label: "Codex", currentVersion: "0.100.0", latestVersion: "0.101.0", status: "available", sourceUrl: "https://developers.openai.com/codex/cli/", updatable: true },
          { id: "claude", label: "Claude", currentVersion: null, latestVersion: null, status: "error", sourceUrl: "https://code.claude.com/docs" },
          { id: "cursor", label: "Cursor", currentVersion: null, latestVersion: null, status: "manual", sourceUrl: "https://cursor.com/docs" },
        ],
        busy: true, updating: null, progress: null, error: false, updateError: null, updated: [], visible: true,
        check: vi.fn(), dismiss: vi.fn(), updateCli: vi.fn(), updateAll: vi.fn(),
      }} />
    </I18nProvider>,
  );
  expect(html).toContain("0.100.0 → 0.101.0");
  expect(html).toContain("有新版本");
  expect(html).toContain("更新");
  expect(html).toContain("全部更新");
  expect(html).toContain("無法確認版本");
  expect(html).toContain("需至官方網站確認更新");
  expect(html).toContain("disabled");
  expect(html).not.toContain("無較新的穩定版");
});
