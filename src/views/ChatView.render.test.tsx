/**
 * Static renders of the chat page: the empty state, a fresh thread's
 * settings row, and the rule that the interface never calls an assistant a
 * "CLI".
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { CHAT_ACCOUNT_PROFILES_KEY } from "../app/chatAccountProfiles";
import { reconcileChatLayout } from "../app/chatThreadLayout";
import { emptySessionSidebarLayout } from "../app/sessionSidebarLayout";
import {
  fakeAgentApi,
  fakeAutomationsApi,
  fakeChatApi,
  fakeDefinition,
  fakeSession,
  fakeThread,
  installFakeStorage,
} from "../app/testFixtures/agentApis";
import { I18nProvider } from "../i18n";
import { ChatView } from "./ChatView";

function render(
  chat = fakeChatApi(),
  agents = fakeAgentApi({
    catalog: [
      fakeDefinition(),
      fakeDefinition({ id: "claude", label: "Claude Code", executable: "claude" }),
    ],
  }),
  onBrowseHistory?: () => void,
): string {
  return renderToStaticMarkup(
    <I18nProvider locale="zh-TW">
      <ChatView
        agents={agents}
        chat={chat}
        automations={fakeAutomationsApi()}
        onOpenSession={() => {}}
        onBrowseHistory={onBrowseHistory}
      />
    </I18nProvider>,
  );
}

describe("ChatView", () => {
  it("offers external Codex and Claude conversations in Chat", () => {
    expect(render(fakeChatApi(), undefined, () => {})).toContain("外部對話");
  });
  it("does not offer approval for an unsupported MCP form", () => {
    const thread = fakeThread({ items: [{
      id: "form", type: "approval", requestId: "request", name: "unsupported_input",
      summary: "Account details", input: "{}", decision: "pending",
    }] });
    const markup = render(fakeChatApi({ threads: [thread], activeThreadId: thread.id }));
    expect(markup).toContain("目前還不支援這種提問格式");
    expect(markup).toContain("拒絕");
    expect(markup).not.toContain(">允許</button>");
  });
  it("offers general chat without a folder prerequisite", () => {
    const thread = fakeThread({ workingDirectory: "" });
    const markup = render(fakeChatApi({ threads: [thread], activeThreadId: thread.id }));
    expect(markup).toContain("一般對話");
    expect(markup).toContain("專案資料夾（選填）");
    expect(markup).toContain("傳訊息給 OpenAI Codex");
    expect(markup).not.toContain("先在上方選一個工作目錄");
  });
  let restoreStorage: (() => void) | null = null;
  afterEach(() => {
    restoreStorage?.();
    restoreStorage = null;
  });

  it("explains the empty state and offers a new conversation", () => {
    const markup = render();
    expect(markup).toContain("還沒有對話");
    expect(markup).toContain("新對話");
  });

  it("hides the account name when only the default account exists", () => {
    const thread = fakeThread();
    const markup = render(fakeChatApi({ threads: [thread], activeThreadId: thread.id }));

    expect(markup).not.toContain("使用帳號");
    expect(markup).not.toContain("me@example.com");
    expect(markup).toContain("OpenAI Codex · 預設");
    expect(markup).toContain("每次詢問");
    expect(markup).toContain("跟 OpenAI Codex 開始對話");
    // The interface talks about assistants; the CLI is an implementation detail.
    const visibleText = markup.replace(/<[^>]+>/g, " ");
    expect(visibleText).not.toMatch(/\bCLI\b/);
  });

  it("shows the proxy model field even when native Codex is signed out", () => {
    const thread = fakeThread({ provider: "cliproxyapi", model: "proxy-model" });
    const definition = fakeDefinition();
    const markup = render(fakeChatApi({ threads: [thread], activeThreadId: thread.id }), fakeAgentApi({
      catalog: [{ ...definition, account: { ...definition.account, state: "signedOut" } }],
    }));
    expect(markup).toContain("CLIProxyAPI 模型 ID");
    expect(markup).toContain('value="proxy-model"');
    expect(markup).not.toContain('chat-settings__warning');
  });

  it("always exposes delete from the conversation row", () => {
    const thread = fakeThread({ title: "可以刪除的對話" });
    const markup = render(
      fakeChatApi({
        threads: [thread],
        activeThreadId: thread.id,
        layout: reconcileChatLayout(emptySessionSidebarLayout, [thread]),
      }),
    );

    expect(markup).toContain('aria-label="刪除對話：可以刪除的對話"');
  });

  it("mirrors live Work Sessions in the conversation sidebar", () => {
    const agents = fakeAgentApi({
      catalog: [fakeDefinition()],
      sessions: [
        fakeSession({
          label: "OpenAI Codex",
          workingDirectory: "D:\\project\\LatticeTerm",
          model: "gpt-5.6-sol",
        }),
      ],
    });
    const markup = render(fakeChatApi(), agents);

    expect(markup).toContain("工作階段");
    expect(markup).toContain("LatticeTerm");
    expect(markup).toContain("OpenAI Codex");
    expect(markup).toContain("gpt-5.6-sol");
  });

  it("lists a named account with its login state in the thread settings", () => {
    restoreStorage = installFakeStorage({
      [CHAT_ACCOUNT_PROFILES_KEY]: JSON.stringify([
        { id: "work", definitionId: "codex", name: "公司帳號", configDirectory: "/p/work" },
      ]),
    });
    const thread = fakeThread({ accountProfileId: "work" });
    const markup = render(fakeChatApi({ threads: [thread], activeThreadId: thread.id }));

    expect(markup).toContain("公司帳號 · OpenAI Codex");
    expect(markup).toContain('value="[&quot;codex&quot;,&quot;work&quot;,null,&quot;&quot;]" selected');
    expect(markup).not.toContain("使用帳號");
  });

  it("keeps a removed account visibly missing instead of selecting the default", () => {
    const thread = fakeThread({ accountProfileId: "removed" });
    const markup = render(fakeChatApi({ threads: [thread], activeThreadId: thread.id }));
    expect(markup).toContain("原帳號已移除，請重新選擇模型");
    expect(markup).toContain('disabled="" selected=""');
  });
});
