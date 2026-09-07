import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { AgentAccountProfileDialog } from "./AgentAccountProfileDialog";

describe("AgentAccountProfileDialog", () => {
  it.each(["OpenAI Codex", "Claude Code"])("adds %s with only a name and a sign-in action", (agentLabel) => {
    const markup = renderToStaticMarkup(
      <I18nProvider locale="zh-TW">
        <AgentAccountProfileDialog
          agentLabel={agentLabel}
          onSave={vi.fn()}
          onCancel={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain(`新增另一個 ${agentLabel} 帳號`);
    expect(markup).toContain("加入後會開啟終端機");
    expect(markup).toContain("帳號名稱");
    expect(markup).toContain("加入並登入");
    expect(markup.match(/<input\b/g)).toHaveLength(1);
    expect(markup).toContain("無需選擇資料夾");
    expect(markup).not.toContain("選擇設定目錄");
    expect(markup).not.toContain("<details");
    expect(markup).not.toContain("CODEX_HOME");
    expect(markup).not.toContain("CLAUDE_CONFIG_DIR");
  });
});
