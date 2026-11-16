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
    nativeCommandPending: false, readError: null, loading: false, slow: false, output: "Working", outputError: null,
    sendError: null as string | null, sending: false, queued: null as number | null, send: vi.fn(), acknowledge: vi.fn(),
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
  beforeEach(() => { conversation.messages = []; conversation.availability = "ready"; conversation.truncated = false; conversation.queued = null; conversation.sendError = null; conversation.nativeCommandPending = false; });

  it("shows a pending native receipt without claiming completion or discarding the editable draft", () => {
    conversation.nativeCommandPending = true; conversation.queued = 0;
    const html = render("done", "codex", { stateSource: "integration" });
    expect(html).not.toContain("原生指令待確認</span>");
    expect(html).toContain("原生指令仍待確認完成");
    expect(html).toContain("session-chat__spinner");
    expect(html).not.toContain("訊息已送出");
    expect(html).not.toContain("任務完成");
    expect(html).not.toMatch(/<textarea[^>]*disabled/);
  });

  it("keeps an initial readiness rejection actionable without claiming the draft was queued", () => {
    conversation.sendError = "session-prompt-not-ready";
    const html = render("done", "codex", { stateSource: "heuristic" });
    expect(html).toContain("這裡的草稿會保留，訊息尚未送出或加入佇列");
    expect(html.match(/aria-label="終端機"/g)).toHaveLength(1);
    expect(html).not.toContain("session-prompt-not-ready</");
    expect(html).not.toMatch(/<textarea[^>]*disabled/);
  });

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

  it("keeps delivery and queue notices in a separate centered composer region", () => {
    conversation.queued = 0;
    const delivered = render("done", "codex", { stateSource: "integration" });
    expect(delivered).toMatch(/session-composer__notices"><p role="status">訊息已送出[^<]*<\/p><\/div><div class="session-composer__frame">/);
    const queued = render("done", "codex", { stateSource: "integration", queuedPrompts: 2 });
    expect(queued).toMatch(/session-composer__notices"><div role="status"><p>還有 2 則訊息排隊/);
    conversation.queued = null;
    expect(render("working")).toContain('<div class="session-composer__notices"></div>');
  });

  it("does not show a terminal-output disclosure before native messages arrive", () => {
    const html = render("working");
    expect(html).not.toContain("session-chat__output");
    expect(html).not.toContain("最近的終端輸出");
  });

  it("renders native pasted image markers as attachments and keeps the caption", () => {
    conversation.messages = [{ role: "user", text: '<image name=[Image #1] path="/synthetic/pasted.png">\n</image>\n[Image #1] 請檢查圖片' }];
    const html = render("done");
    expect(html).toContain("請檢查圖片");
    expect(html).not.toContain("pasted.png");
    expect(html).not.toContain("&lt;image name=");
    expect(html).not.toContain("[Image #1]");
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

  it("keeps native messages without a terminal-output disclosure in every lifecycle state", () => {
    conversation.messages = [{ role: "assistant", text: "已完成記憶交接修正" }];
    for (const state of ["working", "needsAttention", "done"] as const) {
      const html = render(state);
      expect(html).toContain("已完成記憶交接修正");
      expect(html).not.toContain("session-chat__output");
      expect(html.includes("session-chat__spinner")).toBe(state === "working");
    }
  });

  it.each(["codex", "claude"])("pairs native tool records while preserving messages and showing escaped error output (%s)", definitionId => {
    conversation.messages = [
      { role: "user", text: "請幫我檢查檔案" },
      { role: "assistant", text: '{"command":"npm test"}', tool: { callId: "call-1", name: "exec_command", kind: "call" } },
      { role: "assistant", text: '<script>alert("test")</script>\nExit code: 1', tool: { callId: "call-1", name: null, kind: "result" } },
      { role: "assistant", text: "檢查已完成" },
    ];
    const html = render("working", definitionId);
    expect(html).toContain("請幫我檢查檔案");
    expect(html).toContain("檢查已完成");
    expect(html.match(/chat-card--tool/g)).toHaveLength(1);
    expect(html).toContain("指令細節與原始呼叫");
    expect(html).toContain("npm test");
    expect(html).not.toMatch(/<script|call-1/);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("結束碼 1");
    expect(html).toContain("session-chat__activity");
  });

  it("shows paired and orphan native tool cards without terminal output", () => {
    conversation.messages = [
      { role: "assistant", text: "early output", tool: { callId: "call-2", name: null, kind: "result" } },
      { role: "assistant", text: "input", tool: { callId: "call-2", name: "apply_patch", kind: "call" } },
      { role: "assistant", text: "other output", tool: { callId: "call-3", name: null, kind: "result" } },
    ];
    const html = render("done");
    expect(html.match(/chat-card--tool/g)).toHaveLength(2);
    expect(html).toContain("apply_patch");
    expect(html).not.toMatch(/call-2|call-3/);
    expect(html).toContain("early output");
    expect(html).not.toContain('class="session-chat__output" open=""');
  });

  it("shows tool metadata without loading historical image resources", () => {
    conversation.messages = [
      { role: "assistant", text: '{"path":"/private/photo.png"}', tool: { callId: "image-1", name: "view_image", kind: "call" } },
      { role: "assistant", text: "pixels unavailable", tool: { callId: "image-1", name: null, kind: "result" } },
      { role: "assistant", text: "可讀回覆" },
    ];
    const html = render("done");
    expect(html).toContain("可讀回覆");
    expect(html).toContain("view_image");
    expect(html).not.toMatch(/<img|pixels unavailable|image-1/);
  });
});
  it("renders replies without avatars or assistant labels in both conversation views", () => {
    const text = "已完成 **測試**";
    conversation.messages = [{ role: "assistant", text }];
    const frame = renderToStaticMarkup(<ConversationMessage role="assistant" assistant="OpenAI Codex">
      <span>message</span>
    </ConversationMessage>).split('<span>message</span>')[0];
    expect(frame).not.toContain("chat-avatar");
    expect(frame).not.toContain("chat-msg__name");
    const thread = fakeThread({ items: [{ id: "reply", type: "text", text }] });
    const builtin = renderToStaticMarkup(<I18nProvider locale="zh-TW">
      <ChatView agents={fakeAgentApi()} chat={fakeChatApi({ threads: [thread], activeThreadId: thread.id })}
        automations={fakeAutomationsApi()} onOpenSession={() => {}} />
    </I18nProvider>);
    for (const html of [render("done"), builtin]) {
      expect(html).toContain(frame);
      expect(html).toContain('<strong>測試</strong>');
      expect(html).not.toContain("chat-msg__name");
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

it("prioritizes explicit names, custom group titles and native titles before the first prompt or CLI", () => {
  conversation.messages=[{role:"user",text:"Synthetic first prompt"}];
  const title=(props: {displayName?:string;conversationTitle?:string},groupLabel="Codex")=>renderToStaticMarkup(<I18nProvider locale="zh-TW"><SessionConversationPane
    session={fakeSession({label:"Codex",groupLabel})} agents={fakeAgentApi()} {...props} onOpenTerminal={()=>{}} onSessionReplaced={()=>{}}/></I18nProvider>);
  expect(title({displayName:"My renamed chat",conversationTitle:"Native title"},"Group title")).toContain('aria-label="My renamed chat"');
  expect(title({displayName:"Codex"},"Group title")).toContain('<h2 title="Codex" aria-label="Codex">');
  expect(title({conversationTitle:"Native title"},"Group title")).toContain('<h2 title="Group title"');
  expect(title({conversationTitle:"Native title"})).toContain('<h2 title="Native title"');
  expect(title({})).toContain('<h2 title="Synthetic first prompt"');
  conversation.messages=[];
  expect(title({})).toContain('<h2 title="Codex"');
});
