import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { fakeAgentApi, fakeDefinition, fakeRemoteApi, installFakeStorage } from "../app/testFixtures/agentApis";
import { installFakeDom } from "../app/testFixtures/hookDom";
import { I18nProvider } from "../i18n";
import { AgentsView } from "./AgentsView";
import type { AgentMcpAccessApi } from "../app/useAgentMcpAccess";

vi.mock("../app/useAccountProfileStatus", () => ({
  useAccountProfileStatus: () => ({ statuses: {} }),
  accountProfileIdentity: () => "",
  accountProfileOptionKey: () => "",
}));
vi.mock("../components/agents/AgentSkillsPanel", () => ({ AgentSkillsPanel: () => null }));
vi.mock("../components/agents/SharedAgentRulesPanel", () => ({ SharedAgentRulesPanel: () => null }));
vi.mock("../components/agents/AgentRemoteDelivery", () => ({ AgentRemoteDelivery: () => null }));
vi.mock("../components/agents/RemoteFleetPanel", () => ({ RemoteFleetPanel: () => null }));
vi.mock("../components/agents/AgentMcpHistory", () => ({ AgentMcpHistory: () => null }));
vi.mock("../components/agents/ProjectLaunchSettings", () => ({ ProjectLaunchSettings: () => null }));
vi.mock("../components/agents/AgentAccountProfileDialog", () => ({
  AgentAccountProfileDialog: ({ onSave }: { onSave: (name: string) => Promise<void> }) =>
    <button onClick={() => onSave("Fixture account")}>create-account</button>,
}));

type HostNode = { childNodes?: HostNode[]; [key: string]: unknown };
function hostProps(node: HostNode): Record<string, unknown>[] {
  const key = Object.keys(node).find(candidate => candidate.startsWith("__reactProps$"));
  return [...(key ? [node[key] as Record<string, unknown>] : []), ...(node.childNodes ?? []).flatMap(hostProps)];
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([
  ["codex", ["--ask-for-approval", "never", "--sandbox", "danger-full-access"]],
  ["claude", ["--permission-mode", "bypassPermissions"]],
])("starts a newly created %s account with full permissions", async (definitionId, expectedArguments) => {
  const container = installFakeDom();
  vi.stubGlobal("dispatchEvent", vi.fn());
  vi.stubGlobal("addEventListener", vi.fn());
  vi.stubGlobal("removeEventListener", vi.fn());
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((name: string) => {
    const element = createElement(name);
    if (name === "select") Object.defineProperty(element, "options", { value: [] });
    return element;
  });
  document.createElementNS = ((_namespace: string | null, name: string) => document.createElement(name)) as typeof document.createElementNS;
  const restoreStorage = installFakeStorage({});
  const root = createRoot(container as unknown as Element);
  const configDirectory = "C:/fixture/account";
  const invoke = vi.fn(async (command: string) => {
    if (command === "agent_account_profile_directory") return configDirectory;
    throw new Error(`Unexpected command ${command}`);
  });
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
  const agents = fakeAgentApi({ catalog: [fakeDefinition({ id: definitionId as string })] });
  const onOpen = vi.fn();
  const mcp = {
    daemon: { status: { running: false, mcpOutputScopes: false, shared: [], history: null } },
    setAccess: vi.fn(), pending: new Set(), failures: {}, retry: vi.fn(),
  } as unknown as AgentMcpAccessApi;
  const click = async (label: string) => {
    const button = hostProps(container as unknown as HostNode).find(props => props.children === label && typeof props.onClick === "function");
    expect(button, label).toBeDefined();
    await act(async () => { await (button!.onClick as () => unknown)(); });
  };
  try {
    await act(async () => { root.render(<I18nProvider locale="zh-TW"><AgentsView agents={agents} mcp={mcp} remote={fakeRemoteApi()} sandboxAvailable={false} onOpen={onOpen} /></I18nProvider>); });
    await click("新增另一個帳號…");
    await click("create-account");
    expect(invoke).toHaveBeenCalledWith("agent_account_profile_directory", expect.objectContaining({ definitionId }), undefined);
    expect(agents.launch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      definitionId, arguments: expectedArguments, profileConfigPath: configDirectory,
      resumeSessionId: null, detached: false,
    }));
    expect(onOpen).toHaveBeenCalledWith("s1");
  } finally {
    await act(async () => { root.unmount(); });
    restoreStorage();
  }
});
