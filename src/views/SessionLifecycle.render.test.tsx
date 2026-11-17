import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { applyAgentStateEvent } from "../app/useAgentSessions";
import { fakeAgentApi, fakeSession, installFakeStorage } from "../app/testFixtures/agentApis";
import { I18nProvider } from "../i18n";
import { SessionConversationPane } from "../components/chat/SessionConversationPane";
import { SessionsView } from "./SessionsView";

vi.mock("../components/agents/AgentTerminalPane", () => ({ AgentTerminalPane: () => null }));
afterEach(() => vi.unstubAllGlobals());

it.each(["heuristic", "integration"] as const)("clears sidebar, tab and conversation activity from the same backend idle event (%s)", source => {
  const restore = installFakeStorage();
  vi.stubGlobal("window", { innerWidth: 1200, innerHeight: 800 });
  const initial = fakeSession({ state: "working", stateSource: "heuristic" });
  const other = fakeSession({ sessionId: "other-session", groupId: "other-group", state: "idle" });
  function render(sessions: typeof initial[]) {
    const agents = fakeAgentApi({ sessions });
    const empty = { sessions: [], lastClosed: null };
    const props = { agents, ssh: empty, sftp: empty, remote: empty, rdp: empty, vnc: empty,
      activeSessionId: initial.sessionId, onSelect: vi.fn(), theme: "dark", sessionRestoreComplete: true,
      restoredWorkspaceSessions: [], unrestoredWorkspaceSessions: [] } as unknown as Parameters<typeof SessionsView>[0];
    return renderToStaticMarkup(<I18nProvider locale="zh-TW">
      <SessionsView {...props} />
      <SessionConversationPane session={sessions[0]} agents={agents} onOpenTerminal={vi.fn()} onSessionReplaced={vi.fn()} />
    </I18nProvider>);
  }
  try {
    const before = render([initial, other]);
    expect(before).toContain("session-tree__status status-working");
    expect(before).toContain("cli-switch__status status-working");
    expect(before).toContain('class="session-chat__activity"');
    const next = applyAgentStateEvent([initial, other], { sessionId: initial.sessionId, state: "idle", source });
    expect(next[1]).toBe(other);
    const after = render(next);
    expect(after).not.toContain("status-working");
    expect(after).toContain("session-tree__status status-idle");
    expect(after).toContain("cli-switch__status status-idle");
    expect(after).toContain('class="session-chat__state is-idle"');
    expect(after).not.toContain('class="session-chat__activity"');
  } finally { restore(); }
});
