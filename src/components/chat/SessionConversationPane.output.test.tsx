import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeAgentApi, fakeAutomationsApi, fakeChatApi, fakeSession, fakeThread } from "../../app/testFixtures/agentApis";
import { ChatView } from "../../views/ChatView";
import { ConversationMessage } from "./ConversationPresentation";
import { I18nProvider } from "../../i18n";
import type { SessionConversationMessage } from "../../app/useSessionConversation";

const { conversation } = vi.hoisted(() => ({
  conversation: {
    messages: [] as SessionConversationMessage[],
    availability: "ready" as "waitingForIdentity" | "waitingForTranscript" | "ready", truncated: false,
    readError: null, loading: false, slow: false, output: "Working", outputError: null,
    sendError: null, sending: false, queued: null as number | null, send: vi.fn(), acknowledge: vi.fn(),
    approval: null, answering: false, answerError: null, answer: vi.fn(),
  },
}));
vi.mock("../../app/useSessionConversation", () => ({ useSessionConversation: () => conversation }));
const { SessionConversationPane } = await import("./SessionConversationPane");

function render(state: "working" | "needsAttention" | "done", definitionId = "codex", overrides: Parameters<typeof fakeSession>[0] = {}) {
  return renderToStaticMarkup(<I18nProvider locale="zh-TW">
    <SessionConversationPane session={fakeSession({ state, definitionId, ...overrides })} agents={fakeAgentApi()}
      onOpenTerminal={() => {}} onSessionReplaced={() => {}} />
  </I18nProvider>);
}

describe("session chat output disclosure", () => {
  beforeEach(() => { conversation.messages = []; conversation.availability = "ready"; conversation.truncated = false; conversation.queued = null; });

  it("does not report a queued prompt as sent after a heuristic completion", () => {
    conversation.queued = 1;
    const html = render("done", "codex", { queuedPrompts: 1, stateSource: "heuristic" });
    expect(html).toContain("還有 1 則訊息排隊，尚未送到助理");
    expect(html).toContain("正在等助理回報就緒");
    expect(html).not.toContain("訊息已送出");
  });

  it("keeps the backend queue count visible after the local acknowledgment resets", () => {
    const html = render("done", "codex", { queuedPrompts: 2, stateSource: "integration" });
    expect(html).toContain("還有 2 則訊息排隊，尚未送到助理");
    expect(html).not.toContain("訊息已送出");
    expect(html).not.toContain("正在等助理回報就緒");
  });

  it("reports delivery only for an immediate send with no backend queue", () => {
    conversation.queued = 0;
    expect(render("done", "codex", { stateSource: "integration" })).toContain("訊息已送出");
    expect(render("done", "codex", { stateSource: "integration", queuedPrompts: 1 })).not.toContain("訊息已送出");
  });

  it("keeps the readable fallback visible before native messages arrive", () => {
    expect(render("working")).toContain('class="session-chat__output" open=""');
  });

  it("distinguishes a missing native ID from a record that is not readable yet", () => {
    conversation.availability = "waitingForIdentity";
    expect(render("working")).toContain("尚未取得此工作階段的原生對話 ID");
    expect(render("working")).toContain("不會借用同資料夾的其他對話");
    expect(render("working")).toContain("通常在首輪完成後取得 ID");
    expect(render("working", "claude")).not.toContain("通常在首輪完成後取得 ID");
    conversation.availability = "waitingForTranscript";
    expect(render("working")).toContain("已取得原生對話 ID");
    expect(render("working")).not.toContain("尚未取得此工作階段的原生對話 ID");
  });

  it("discloses omitted records even when some native messages are visible", () => {
    conversation.messages = [{ role: "assistant", text: "最近的回覆" }];
    conversation.truncated = true;
    const html = render("done");
    expect(html).toContain("300 筆訊息與工具紀錄");
    expect(html).toContain("原始紀錄沒有刪除");
    expect(html).toContain("最近的回覆");
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
    expect(html.match(/<details class="chat-card chat-card--tool">/g)).toHaveLength(2);
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
    expect(html.match(/chat-card__label">工具/g)).toHaveLength(2);
  });
});
  it("renders replies with the same avatar, assistant name and Markdown as built-in chat", () => {
    const text = "已完成 **測試**";
    conversation.messages = [{ role: "assistant", text }];
    const frame = renderToStaticMarkup(<ConversationMessage role="assistant" assistant="OpenAI Codex">
      <span>message</span>
    </ConversationMessage>).split('<span>message</span>')[0];
    const thread = fakeThread({ items: [{ id: "reply", type: "text", text }] });
    const builtin = renderToStaticMarkup(<I18nProvider locale="zh-TW">
      <ChatView agents={fakeAgentApi()} chat={fakeChatApi({ threads: [thread], activeThreadId: thread.id })}
        automations={fakeAutomationsApi()} onOpenSession={() => {}} />
    </I18nProvider>);
    for (const html of [render("done"), builtin]) {
      expect(html).toContain(frame);
      expect(html).toContain('<strong>測試</strong>');
      expect(html).not.toContain('chat-msg__name">助理');
    }
  });

  it("renders user text as the same bubble without an extra role label", () => {
    const text = "幫我檢查 <script>內容</script>";
    conversation.messages = [{ role: "user", text }];
    const bubble = renderToStaticMarkup(<ConversationMessage role="user" assistant="OpenAI Codex">
      <div>{text}</div>
    </ConversationMessage>).slice(0, -6);
    const thread = fakeThread({ items: [{ id: "prompt", type: "user", text, at: 1 }] });
    const builtin = renderToStaticMarkup(<I18nProvider locale="zh-TW">
      <ChatView agents={fakeAgentApi()} chat={fakeChatApi({ threads: [thread], activeThreadId: thread.id })}
        automations={fakeAutomationsApi()} onOpenSession={() => {}} />
    </I18nProvider>);
    expect(render("done")).toContain(bubble);
    expect(builtin).toContain(bubble);
    expect(render("done")).not.toContain('<script>');
  });
