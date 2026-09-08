/**
 * Static renders of the Fleet page.  These guard what a person sees on the
 * CLI cards: the account picker with each account's login state, the
 * install command for a CLI that is missing, and the sandbox option only
 * where bubblewrap works.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAT_ACCOUNT_PROFILES_KEY } from "../app/chatAccountProfiles";
import {
  fakeAgentApi,
  fakeDefinition,
  fakeRemoteApi,
  fakeSession,
  installFakeStorage,
} from "../app/testFixtures/agentApis";
import { I18nProvider } from "../i18n";
import { AgentsView } from "./AgentsView";

// The background service is a desktop-only backend; the render tests feed
// it a status directly.
type SharedEntry = {
  sessionId: string;
  control: boolean;
  activity?: { client: string; action: string; at: number } | null;
};
const daemonStatus = vi.hoisted(() => ({
  current: {
    running: false,
    sessions: 0,
    shared: [] as SharedEntry[],
    mcp: null as null | { command: string; args: string[] },
  },
}));
vi.mock("../app/useAgentDaemon", () => ({
  EMPTY_DAEMON_STATUS: { running: false, sessions: 0, shared: [], mcp: null },
  useAgentDaemon: () => ({
    status: daemonStatus.current,
    refresh: vi.fn(),
    stop: vi.fn(),
    share: vi.fn(),
    control: vi.fn(),
  }),
}));

function render(
  agents = fakeAgentApi(),
  { sandboxAvailable = false } = {},
): string {
  return renderToStaticMarkup(
    <I18nProvider locale="zh-TW">
      <AgentsView
        agents={agents}
        remote={fakeRemoteApi()}
        sandboxAvailable={sandboxAvailable}
        onOpen={vi.fn()}
      />
    </I18nProvider>,
  );
}

describe("AgentsView", () => {
  let restoreStorage: (() => void) | null = null;
  afterEach(() => {
    restoreStorage?.();
    restoreStorage = null;
    daemonStatus.current = { running: false, sessions: 0, shared: [], mcp: null };
  });

  it("offers MCP sharing only for background sessions and shows the client snippets", () => {
    daemonStatus.current = {
      running: true,
      sessions: 1,
      shared: [
        {
          sessionId: "agent-bg-session-1",
          control: true,
          activity: { client: "Claude Code 2.1", action: "prompt", at: Date.now() },
        },
      ],
      mcp: { command: "/opt/lattice-term", args: ["mcp", "--data-dir", "/data dir"] },
    };
    const markup = render(
      fakeAgentApi({
        sessions: [
          fakeSession({ sessionId: "agent-bg-session-1", label: "Codex 背景", detached: true }),
          fakeSession({ sessionId: "agent-session-2", label: "Codex 桌面" }),
        ],
      }),
    );

    expect(markup).toContain("背景服務執行中：1 個工作階段");
    expect(markup).toContain("分享給外部 AI（MCP）");
    expect(markup).toContain("已分享 1 個工作階段");
    expect(markup).toContain("claude mcp add latticeterm -- /opt/lattice-term mcp --data-dir &#x27;/data dir&#x27;");
    expect(markup).toContain("[mcp_servers.latticeterm]");
    // One toggle: the desktop-owned session has no observer path.
    expect(markup.match(/<span>分享給 MCP<\/span>/g)).toHaveLength(1);
    expect(markup).toContain("checked=\"\"");
    // A shared session offers the control grant and shows who acted on it.
    expect(markup).toContain("允許 MCP 送指示與停止");
    expect(markup).toContain("MCP 可控");
    expect(markup).toContain("MCP：Claude Code 2.1 送出了指示（剛剛）");
    // Launching is a separate, off-by-default switch.
    expect(markup).toContain("允許 MCP 啟動已保存的背景啟動項目");
  });

  it("offers no control grant on a session that is only shared", () => {
    daemonStatus.current = {
      running: true,
      sessions: 1,
      shared: [{ sessionId: "agent-bg-session-1", control: false }],
      mcp: { command: "/opt/lattice-term", args: ["mcp"] },
    };
    const markup = render(
      fakeAgentApi({
        sessions: [fakeSession({ sessionId: "agent-bg-session-1", detached: true })],
      }),
    );
    expect(markup).toContain("允許 MCP 送指示與停止");
    expect(markup).not.toContain("MCP 可控");
    expect(markup).not.toContain("MCP：");
  });

  it("offers the account picker with the signed-in default and a named account", () => {
    restoreStorage = installFakeStorage({
      [CHAT_ACCOUNT_PROFILES_KEY]: JSON.stringify([
        { id: "work", definitionId: "codex", name: "公司帳號", configDirectory: "/p/work", managed: true },
      ]),
    });
    const markup = render();

    expect(markup).toContain("啟動時使用的帳號");
    expect(markup).toContain("目前登入的帳號：me@example.com");
    // Before the backend answers, a named account is listed with an unknown state.
    expect(markup).toContain("公司帳號（登入狀態未知）");
    expect(markup).toContain("新增另一個帳號…");
    expect(markup).not.toContain("帳號設定檔");
  });

  it("does not offer accounts for a CLI without profile support", () => {
    const markup = render(fakeAgentApi({
      catalog: [fakeDefinition({ id: "gemini", label: "Gemini CLI", executable: "gemini" })],
    }));

    expect(markup).not.toContain("啟動時使用的帳號");
    expect(markup).not.toContain("新增另一個帳號…");
  });

  it("shows the fixed install command instead of a launch for a missing CLI", () => {
    const markup = render(fakeAgentApi({
      catalog: [fakeDefinition({ installed: false, installedPath: null })],
    }));

    expect(markup).toContain("npm install -g @openai/codex");
    expect(markup).not.toContain("啟動時使用的帳號");
  });

  it("offers keeping a session in the background and badges one that is", () => {
    const markup = render(fakeAgentApi({
      sessions: [fakeSession({ detached: true, label: "夜間批次" })],
    }));
    expect(markup).toContain("留在背景");
    expect(markup).toContain("夜間批次");
    expect(markup).toContain(">背景<");
  });

  it("badges a saved launch plan that restores into the background", () => {
    const markup = render(fakeAgentApi({
      plans: [{
        id: "plan-1",
        definitionId: "codex",
        label: "夜間批次",
        executable: "",
        arguments: [],
        resumeSessionId: null,
        note: "",
        sandbox: false,
        detached: true,
        workingDirectory: "/work",
      }],
    }));
    expect(markup).toContain("夜間批次");
    expect(markup).toContain(">背景<");
  });

  it("offers the sandbox only when bubblewrap was probed to work", () => {
    expect(render(fakeAgentApi(), { sandboxAvailable: true })).toContain("bubblewrap");
    expect(render(fakeAgentApi(), { sandboxAvailable: false })).not.toContain("bubblewrap");
  });
});
