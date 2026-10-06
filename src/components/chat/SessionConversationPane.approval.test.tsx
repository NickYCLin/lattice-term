/**
 * A permission prompt the terminal shows can be answered from the chat view.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { fakeAgentApi, fakeSession } from "../../app/testFixtures/agentApis";
import { I18nProvider } from "../../i18n";

vi.mock("../../app/useSessionConversation", () => ({
  useSessionConversation: () => ({
    messages: [], readError: null, loading: false, slow: false, output: "", sendError: null,
    sending: false, queued: null, send: vi.fn(), acknowledge: vi.fn(),
    approval: { requestId: "r1", toolName: "Bash", summary: "mkdir build" },
    answering: false, answerError: null, answer: vi.fn(),
  }),
}));

const { SessionConversationPane } = await import("./SessionConversationPane");

describe("SessionConversationPane permission prompt", () => {
  it("offers allow and deny for the prompt the terminal shows", () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="zh-TW">
        <SessionConversationPane session={fakeSession({ state: "needsAttention" })} agents={fakeAgentApi()}
          onOpenTerminal={() => {}} />
      </I18nProvider>,
    );
    expect(html).toContain("chat-card--approval");
    expect(html).toContain("Bash");
    expect(html).toContain("mkdir build");
    expect(html).toContain(">允許<");
    expect(html).toContain(">拒絕<");
    expect(html).toContain("任一邊回覆後另一邊就會收起");
  });
});
