/**
 * Static renders of the session chat composer: the project and machine
 * strip, the access indicator, the model label, the attach menu, dictation
 * and the voice conversation button that stands in for send while empty.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { fakeAgentApi, fakeSession } from "../../app/testFixtures/agentApis";
import { I18nProvider } from "../../i18n";
import { SessionConversationPane } from "./SessionConversationPane";

function render(overrides: Parameters<typeof fakeSession>[0] = {}) {
  return renderToStaticMarkup(
    <I18nProvider locale="zh-TW">
      <SessionConversationPane session={fakeSession(overrides)} agents={fakeAgentApi()} onOpenTerminal={() => {}} />
    </I18nProvider>,
  );
}

describe("SessionConversationPane composer", () => {
  it("offers the terminal only while the assistant waits for the user", () => {
    expect(render({ state: "idle" })).not.toContain("開啟這個工作階段的終端機");
    expect(render({ state: "needsAttention" })).toContain("開啟這個工作階段的終端機");
  });

  it("shows the project folder, this computer and the session model", () => {
    const html = render({ workingDirectory: "D:\\project\\LatticeTerm", model: "claude-opus-4-5" });
    expect(html).toContain('title="D:\\project\\LatticeTerm"');
    expect(html).toContain("<span>LatticeTerm</span>");
    expect(html).toContain("這台電腦");
    expect(html).toContain('placeholder="想做什麼都可以"');
    expect(html).toContain("claude-opus-4-5");
    expect(html).toContain('aria-label="新增檔案和更多內容"');
    expect(html).toMatch(/class="session-composer__icon" disabled=""[^>]*aria-label="這個平台沒有可用的語音辨識，暫時無法聽寫"/);
    expect(html).toMatch(/class="session-composer__voice" disabled=""/);
    expect(html).not.toContain('class="chat-send"');
  });

  it("marks an unsandboxed session as full file access", () => {
    const html = render({ sandboxed: false });
    expect(html).toContain('class="session-composer__access"');
    expect(html).toContain("完整檔案存取");
    expect(html).toContain("Claude Code 或 Codex 要求權限時可以直接在這裡允許或拒絕；其他互動請開啟終端機處理。");
  });

  it("marks a sandboxed session and falls back to the CLI name without a model", () => {
    const html = render({ sandboxed: true, model: null, label: "Claude Code" });
    expect(html).toContain('class="session-composer__access is-sandboxed"');
    expect(html).toContain("沙箱保護");
    expect(html).toMatch(/session-composer__model[^>]*>Claude Code</);
  });
});
