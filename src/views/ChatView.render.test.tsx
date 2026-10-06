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
import { NativeHistoryContext, type NativeHistory } from "../app/useNativeConversations";
import type { LocalConversation } from "../app/localConversationSessions";
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
): string {
  return renderToStaticMarkup(
    <I18nProvider locale="zh-TW">
      <ChatView
        agents={agents}
        chat={chat}
        automations={fakeAutomationsApi()}
        onOpenSession={() => {}}
      />
    </I18nProvider>,
  );
}

describe("ChatView", () => {
  it("renders an existing workspace session in Chat without creating another conversation", () => {
    const agents = fakeAgentApi({ sessions: [fakeSession({ sessionId: "shared", groupLabel: "Shared project" })] });
    const chat = fakeChatApi();
    const markup = renderToStaticMarkup(
      <I18nProvider locale="zh-TW">
        <ChatView agents={agents} chat={chat} automations={fakeAutomationsApi()}
          workspaceSessionId="shared" onSelectWorkspaceSession={() => {}}
          onOpenSession={() => {}} />
      </I18nProvider>,
    );
    expect(markup).toContain("Shared project");
    expect(markup).toContain("與工作階段頁共用同一個助理");
    expect(markup).toContain("傳送訊息到這個工作階段");
    expect(markup).toContain('aria-current="true"');
    expect(agents.launch).not.toHaveBeenCalled();
    expect(chat.importNativeConversation).not.toHaveBeenCalled();
  });
  it("shows whether a shared session is replying or waiting in the conversation", () => {
    const view = (state: "working" | "needsAttention" | "idle", queuedPrompts = 0) => renderToStaticMarkup(
      <I18nProvider locale="zh-TW">
        <ChatView agents={fakeAgentApi({ sessions: [fakeSession({ sessionId: "shared", state, queuedPrompts })] })}
          chat={fakeChatApi()} automations={fakeAutomationsApi()}
          workspaceSessionId="shared" onSelectWorkspaceSession={() => {}} onOpenSession={() => {}} />
      </I18nProvider>,
    );
    expect(view("working")).toContain("助理正在回覆…");
    expect(view("working", 2)).toContain("還有 2 則訊息排隊");
    expect(view("needsAttention")).toContain("助理可能在等你確認或輸入");
    const idle = view("idle");
    expect(idle).toContain("閒置中");
    expect(idle).not.toContain("助理正在回覆");
  });

  it("lists every CLI conversation directly, without a separate history panel", () => {
    const entry = (nativeSessionId: string, title: string, definitionId: LocalConversation["definitionId"] = "codex"): LocalConversation => ({
      definitionId, profileId: null, nativeSessionId, title, workingDirectory: "/work/app", resumable: true, updatedAt: 1,
    });
    const history = {
      entries: [entry("one", "Codex Desktop 對話"), entry("two", "已開啟過的對話"), entry("three", "Gemini 對話", "gemini"),
        { ...entry("four", "已封存的對話"), archived: true }],
      profiles: [], profileKey: "[]", hasMore: false, busy: false, error: null,
    } as unknown as NativeHistory;
    const opened = fakeThread({ title: "已開啟過的對話", nativeSessionId: "two", accountProfileId: null });
    const markup = renderToStaticMarkup(
      <NativeHistoryContext.Provider value={history}>
        <I18nProvider locale="zh-TW">
          <ChatView agents={fakeAgentApi()} chat={fakeChatApi({ threads: [opened] })}
            automations={fakeAutomationsApi()} onOpenSession={() => {}} />
        </I18nProvider>
      </NativeHistoryContext.Provider>,
    );
    expect(markup).toContain("Codex Desktop 對話");
    expect(markup).toContain("Gemini 對話");
    expect(markup.match(/已開啟過的對話/g)?.length).toBeGreaterThanOrEqual(1);
    expect(markup).not.toContain("chat-native-rows__error");
    expect(markup).not.toContain("已封存的對話");
    expect(markup).not.toContain("外部對話");
    expect(markup).not.toContain("原生對話");
    const rows = markup.slice(markup.indexOf("chat-native-rows"));
    expect(rows).not.toContain("已開啟過的對話");
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

  it("names the default account when it is the only one", () => {
    const thread = fakeThread();
    const markup = render(fakeChatApi({ threads: [thread], activeThreadId: thread.id }));

    expect(markup).not.toContain("使用帳號");
    expect(markup).toContain("me@example.com · OpenAI Codex · 預設");
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

  it("puts live sessions and conversations in the same sidebar tree", () => {
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
    const thread = fakeThread({ title: "改版討論" });
    const markup = render(fakeChatApi({ threads: [thread], activeThreadId: thread.id }), agents);

    // One tree, one folder column: only the row markup tells the kinds apart.
    expect(markup.match(/class="chat-tree"/g)).toHaveLength(1);
    expect(markup).toContain("LatticeTerm");
    expect(markup).toContain("OpenAI Codex");
    expect(markup).toContain("gpt-5.6-sol");
    expect(markup).toContain("chat-session");
    expect(markup).toContain("改版討論");
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
    expect(markup).toContain('value="[&quot;codex&quot;,&quot;work&quot;,null,null,&quot;&quot;]" selected');
    expect(markup).not.toContain("使用帳號");
  });

  it("keeps a removed account visibly missing instead of selecting the default", () => {
    const thread = fakeThread({ accountProfileId: "removed" });
    const markup = render(fakeChatApi({ threads: [thread], activeThreadId: thread.id }));
    expect(markup).toContain("原帳號已移除，請重新選擇模型");
    expect(markup).toContain('disabled="" selected=""');
  });
});
