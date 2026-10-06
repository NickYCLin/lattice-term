import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeAgentApi, fakeSession } from "../../app/testFixtures/agentApis";
import { I18nProvider } from "../../i18n";

const { conversation } = vi.hoisted(() => ({
  conversation: {
    messages: [] as Array<{ role: "user" | "assistant"; text: string }>,
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
});
