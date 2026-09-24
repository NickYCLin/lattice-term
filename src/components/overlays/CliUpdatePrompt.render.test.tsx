import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { CliUpdatePrompt } from "./CliUpdatePrompt";

it("distinguishes available, unknown and manually checked CLIs with direct update", () => {
  const html = renderToStaticMarkup(
    <I18nProvider locale="zh-TW">
      <CliUpdatePrompt updates={{
        items: [
          { id: "codex", label: "Codex", currentVersion: "0.100.0", latestVersion: "0.101.0", status: "available", sourceUrl: "https://developers.openai.com/codex/cli/", updatable: true },
          { id: "claude", label: "Claude", currentVersion: null, latestVersion: null, status: "error", sourceUrl: "https://code.claude.com/docs" },
          { id: "cursor", label: "Cursor", currentVersion: null, latestVersion: null, status: "manual", sourceUrl: "https://cursor.com/docs" },
        ],
        busy: true, updating: null, error: false, updateError: null, visible: true,
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
