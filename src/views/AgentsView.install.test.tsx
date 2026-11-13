import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { fakeAgentApi, fakeDefinition, fakeRemoteApi, fakeSession, installFakeStorage } from "../app/testFixtures/agentApis";
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
vi.mock("../components/overlays/ConfirmDialog", () => ({
  ConfirmDialog: ({ onConfirm }: { onConfirm: () => void }) => <button onClick={onConfirm}>confirm-install</button>,
}));

type HostNode = { childNodes?: HostNode[]; [key: string]: unknown };
function hostProps(node: HostNode): Record<string, unknown>[] {
  const key = Object.keys(node).find(candidate => candidate.startsWith("__reactProps$"));
  return [...(key ? [node[key] as Record<string, unknown>] : []), ...(node.childNodes ?? []).flatMap(hostProps)];
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(["Exit 0", "Exit 1", null])("refreshes the catalog after an installation closes (%s)", async closedReason => {
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
  const session = fakeSession({ definitionId: "custom", closedReason });
  let closeHandler: ((reason: string) => void) | undefined;
  const stopWatching = vi.fn();
  const agents = fakeAgentApi({
    catalog: [fakeDefinition({ installed: false, installedPath: null })],
    launch: vi.fn(async () => session),
    onClosed: vi.fn((_sessionId, handler) => { closeHandler = handler; return stopWatching; }),
  });
  const onOpen = vi.fn();
  const mcp = {
    daemon: { status: { running: false, mcpOutputScopes: false, shared: [], history: null } },
    setAccess: vi.fn(), pending: new Set(), failures: {}, retry: vi.fn(),
  } as unknown as AgentMcpAccessApi;
  const click = async (label: string) => {
    const button = hostProps(container as unknown as HostNode).find(props =>
      (props.children === label || Array.isArray(props.children) && props.children.includes(label)) && typeof props.onClick === "function");
    expect(button, label).toBeDefined();
    await act(async () => { (button!.onClick as () => void)(); });
  };
  try {
    await act(async () => { root.render(<I18nProvider locale="zh-TW"><AgentsView agents={agents} mcp={mcp} remote={fakeRemoteApi()} sandboxAvailable={false} onOpen={onOpen} /></I18nProvider>); });
    await click("安裝");
    await click("confirm-install");
    expect(agents.launch).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith(session.sessionId);
    if (closedReason) {
      expect(agents.onClosed).not.toHaveBeenCalled();
    } else {
      expect(agents.refreshCatalog).not.toHaveBeenCalled();
      expect(agents.onClosed).toHaveBeenCalledWith(session.sessionId, expect.any(Function));
      await act(async () => { closeHandler!("Exit 0"); });
      expect(stopWatching).toHaveBeenCalledOnce();
    }
    expect(agents.refreshCatalog).toHaveBeenCalledOnce();
  } finally {
    await act(async () => { root.unmount(); });
    restoreStorage();
  }
});
