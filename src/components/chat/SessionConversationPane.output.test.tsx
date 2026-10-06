import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeAgentApi, fakeSession } from "../../app/testFixtures/agentApis";
import { I18nProvider } from "../../i18n";
import type { SessionConversationMessage } from "../../app/useSessionConversation";

const { conversation } = vi.hoisted(() => ({
  conversation: {
    messages: [] as SessionConversationMessage[],
    readError: null, loading: false, slow: false, output: "Working", outputError: null,
    sendError: null, sending: false, queued: null, send: vi.fn(), acknowledge: vi.fn(),
    approval: null, answering: false, answerError: null, answer: vi.fn(),
  },
}));
vi.mock("../../app/useSessionConversation", () => ({ useSessionConversation: () => conversation }));
const { SessionConversationPane } = await import("./SessionConversationPane");

function render(state: "working" | "needsAttention" | "done") {
  return renderToStaticMarkup(<I18nProvider locale="zh-TW">
    <SessionConversationPane session={fakeSession({ state })} agents={fakeAgentApi()}
      onOpenTerminal={() => {}} onSessionReplaced={() => {}} />
  </I18nProvider>);
}

describe("session chat output disclosure", () => {
  beforeEach(() => { conversation.messages = []; });

  it("keeps the readable fallback visible before native messages arrive", () => {
    expect(render("working")).toContain('class="session-chat__output" open=""');
  });

  it("puts native messages first and stops expanding the terminal on every working turn", () => {
    conversation.messages = [{ role: "assistant", text: "已完成記憶交接修正" }];
    for (const state of ["working", "needsAttention", "done"] as const) {
      const html = render(state);
      expect(html).not.toContain('class="session-chat__output" open=""');
      expect(html.indexOf("已完成記憶交接修正")).toBeLessThan(html.indexOf("session-chat__output"));
    }
  });

  it("renders linked tool input and output as collapsed plain-text cards", () => {
    conversation.messages = [
      { role: "assistant", text: '{"command":"npm test"}', tool: { callId: "call-1", name: "exec_command", kind: "call" } },
      { role: "assistant", text: '<script>alert("test")</script>\nExit code: 1', tool: { callId: "call-1", name: null, kind: "result" } },
    ];
    const html = render("working");
    expect(html.match(/<details class="session-chat__tool">/g)).toHaveLength(2);
    expect(html.match(/exec_command/g)).toHaveLength(2);
    expect(html).toContain("呼叫內容");
    expect(html).toContain("回傳內容");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("chat-card--tool is-running");
  });

  it("does not borrow a name from another call or a later tool invocation", () => {
    conversation.messages = [
      { role: "assistant", text: "early output", tool: { callId: "call-2", name: null, kind: "result" } },
      { role: "assistant", text: "input", tool: { callId: "call-2", name: "apply_patch", kind: "call" } },
      { role: "assistant", text: "other output", tool: { callId: "call-3", name: null, kind: "result" } },
    ];
    const html = render("done");
    expect(html.match(/apply_patch/g)).toHaveLength(1);
    expect(html.match(/<summary>工具/g)).toHaveLength(2);
  });
});
