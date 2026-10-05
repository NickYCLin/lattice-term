/**
 * Static renders of the session chat composer: the project and machine
 * strip, the access indicator, the model label and the round send button.
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
  it("shows the project folder, this computer and the session model", () => {
    const html = render({ workingDirectory: "D:\\project\\LatticeTerm", model: "claude-opus-4-5" });
    expect(html).toContain('title="D:\\project\\LatticeTerm"');
    expect(html).toContain("<span>LatticeTerm</span>");
    expect(html).toContain("這台電腦");
    expect(html).toContain('placeholder="想做什麼都可以"');
    expect(html).toContain("claude-opus-4-5");
    expect(html).toMatch(/class="chat-send"[^>]*disabled=""[^>]*aria-label="傳送"/);
  });

  it("marks an unsandboxed session as full file access", () => {
    const html = render({ sandboxed: false });
    expect(html).toContain('class="session-composer__access"');
    expect(html).toContain("完整檔案存取");
    expect(html).toContain("若助理等待權限確認或其他互動，請開啟終端機處理。");
  });

  it("marks a sandboxed session and falls back to the CLI name without a model", () => {
    const html = render({ sandboxed: true, model: null, label: "Claude Code" });
    expect(html).toContain('class="session-composer__access is-sandboxed"');
    expect(html).toContain("沙箱保護");
    expect(html).toMatch(/session-composer__model[^>]*>Claude Code</);
  });
});
