/**
 * Static renders of the chat page: the empty state, a fresh thread's
 * settings row, and the rule that the interface never calls an assistant a
 * "CLI".
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { CHAT_ACCOUNT_PROFILES_KEY } from "../app/chatAccountProfiles";
import {
  fakeAgentApi,
  fakeAutomationsApi,
  fakeChatApi,
  fakeDefinition,
  fakeThread,
  installFakeStorage,
} from "../app/testFixtures/agentApis";
import { I18nProvider } from "../i18n";
import { ChatView } from "./ChatView";

function render(chat = fakeChatApi()): string {
  const agents = fakeAgentApi({
    catalog: [
      fakeDefinition(),
      fakeDefinition({ id: "claude", label: "Claude Code", executable: "claude" }),
    ],
  });
  return renderToStaticMarkup(
    <I18nProvider locale="zh-TW">
      <ChatView agents={agents} chat={chat} automations={fakeAutomationsApi()} />
    </I18nProvider>,
  );
}

describe("ChatView", () => {
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

  it("lists a named account with its login state in the thread settings", () => {
    restoreStorage = installFakeStorage({
      [CHAT_ACCOUNT_PROFILES_KEY]: JSON.stringify([
        { id: "work", definitionId: "codex", name: "公司帳號", configDirectory: "/p/work" },
      ]),
    });
    const thread = fakeThread({ accountProfileId: "work" });
    const markup = render(fakeChatApi({ threads: [thread], activeThreadId: thread.id }));

    expect(markup).toContain("公司帳號 · OpenAI Codex");
    expect(markup).toContain('value="[&quot;codex&quot;,&quot;work&quot;,&quot;&quot;]" selected');
    expect(markup).not.toContain("使用帳號");
  });

  it("keeps a removed account visibly missing instead of selecting the default", () => {
    const thread = fakeThread({ accountProfileId: "removed" });
    const markup = render(fakeChatApi({ threads: [thread], activeThreadId: thread.id }));
    expect(markup).toContain("原帳號已移除，請重新選擇模型");
    expect(markup).toContain('disabled="" selected=""');
  });
});
