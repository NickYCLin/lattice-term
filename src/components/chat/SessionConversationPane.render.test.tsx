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
      <SessionConversationPane session={fakeSession(overrides)} agents={fakeAgentApi()} onOpenTerminal={() => {}} onSessionReplaced={() => {}} />
    </I18nProvider>,
  );
}

describe("SessionConversationPane composer", () => {
  it("uses the sidebar assistant name as the title instead of the group name", () => {
    const html = render({ definitionId: "codex", label: "OpenAI Codex", groupLabel: "Claude Code",
      workingDirectory: "D:/project/LatticeTerm", model: "gpt-6.1-sol" });
    expect(html).toContain('<h2>OpenAI Codex</h2>');
    expect(html).not.toContain('<h2>Claude Code</h2>');
    expect(html).toContain('class="chat-header__identity"');
    expect(html).toContain('class="chat-avatar"');
    expect(html).toContain('OpenAI Codex · gpt-6.1-sol');
    expect(html).toContain('class="chat-chip">群組 · Claude Code</span>');
    expect(html).toContain('class="callout callout--info"');
    expect(html).toContain('aria-label="終端機"');
    expect(html).not.toContain('session-chat__title');
  });

  it("keeps a real Claude session labeled as Claude", () => {
    const html = render({ definitionId: "claude", label: "Claude Code", groupLabel: "Project" });
    expect(html).toContain('<h2>Claude Code</h2>');
    expect(html).toContain('class="chat-chip">Claude Code</span>');
    expect(html).not.toContain('OpenAI Codex');
  });

  it("offers the terminal for unconfirmed readiness and pending user input", () => {
    expect(render({ state: "idle", stateSource: "integration" })).not.toContain("開啟這個工作階段的終端機");
    expect(render({ state: "idle", stateSource: "heuristic" })).toContain("開啟這個工作階段的終端機");
    expect(render({ state: "needsAttention" })).toContain("開啟這個工作階段的終端機");
  });

  it("does not label a restored heuristic completion as ready to receive messages", () => {
    const html = render({ state: "done", stateSource: "heuristic", restoreExistingSession: true });
    expect(html).toContain("尚未確認就緒");
    expect(html).toContain("這裡的草稿會保留");
    expect(html).not.toContain("任務完成");
    expect(html).toMatch(/session-composer__model" disabled=""/);
    expect(html).not.toMatch(/<textarea[^>]*disabled/);
    expect(render({ state: "done", stateSource: "integration" })).not.toContain("這裡的草稿會保留");
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
