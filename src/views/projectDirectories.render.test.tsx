import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { fakeAgentApi, fakeSession, fakeChatApi, fakeAutomationsApi } from "../app/testFixtures/agentApis";
import { SessionsView } from "./SessionsView";
import { ChatView } from "./ChatView";
vi.mock("../components/agents/AgentTerminalPane", () => ({ AgentTerminalPane: () => null }));
afterEach(() => vi.unstubAllGlobals());
it("groups both pages identically and distinguishes duplicate names from different parents", () => {
  vi.stubGlobal("window", { innerWidth: 1280 });
  const sessions = [
    fakeSession({ sessionId: "one", groupId: "one", workingDirectory: "C:\\one\\rust\\" }),
    fakeSession({ sessionId: "alias", groupId: "alias", workingDirectory: "\\\\?\\c:\\ONE\\rust" }),
    fakeSession({ sessionId: "two", groupId: "two", workingDirectory: "C:/two/rust" }),
    fakeSession({ sessionId: "upper", groupId: "upper", workingDirectory: "/work/Frontend" }),
    fakeSession({ sessionId: "lower", groupId: "lower", workingDirectory: "/work/frontend" }),
  ];
  const agents = fakeAgentApi({ sessions });
  const empty = { sessions: [], lastClosed: null };
  const props = { agents, ssh: empty, sftp: empty, remote: empty, rdp: empty, vnc: empty,
    activeSessionId: null, onSelect: () => {}, theme: "dark", sessionRestoreComplete: true,
    restoredWorkspaceSessions: [], unrestoredWorkspaceSessions: [] } as unknown as Parameters<typeof SessionsView>[0];
  const html = [
    renderToStaticMarkup(<I18nProvider locale="zh-TW"><SessionsView {...props} /></I18nProvider>),
    renderToStaticMarkup(<I18nProvider locale="zh-TW"><ChatView agents={agents} chat={fakeChatApi()} automations={fakeAutomationsApi()} onOpenSession={() => {}} /></I18nProvider>),
  ];
  for (const rendered of html) {
    expect(rendered).toContain("rust · …/one"); expect(rendered).toContain("rust · …/two");
    expect(rendered).toContain("Frontend"); expect(rendered).toContain("frontend");
    // One branch per physical Windows folder despite two source spellings.
    expect((rendered.match(/class="(?:truncate|chat-folder__name)">rust · …\/one</g) ?? []).length).toBe(1);
  }
});
