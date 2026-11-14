import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { fakeAgentApi, fakeDefinition, fakeRemoteApi, installFakeStorage } from "../app/testFixtures/agentApis";
import { installFakeDom } from "../app/testFixtures/hookDom";
import { loadChatAccountProfiles, saveChatAccountProfiles, CHAT_ACCOUNT_PROFILES_KEY, type ChatAccountProfile } from "../app/chatAccountProfiles";
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
  ConfirmDialog: ({ onConfirm }: { onConfirm: () => void }) => <button onClick={onConfirm}>confirm-removal</button>,
}));

type HostNode = { childNodes?: HostNode[]; [key: string]: unknown };
function hostProps(node: HostNode): Record<string, unknown>[] {
  const key = Object.keys(node).find(candidate => candidate.startsWith("__reactProps$"));
  return [...(key ? [node[key] as Record<string, unknown>] : []), ...(node.childNodes ?? []).flatMap(hostProps)];
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(["mounted", "unmounted", "failed", "external"])("persists only a completed account removal against the latest list (%s)", async mode => {
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
  const profile: ChatAccountProfile = {
    id: "remove", definitionId: "codex", name: "Remove account", configDirectory: "C:/fixture/remove", managed: mode !== "external",
  };
  const retained = { ...profile, id: "retain", name: "Retain account", configDirectory: "C:/fixture/retain" };
  const concurrent = { ...profile, id: "added", name: "Added account", configDirectory: "C:/fixture/added" };
  const restoreStorage = installFakeStorage({ [CHAT_ACCOUNT_PROFILES_KEY]: JSON.stringify([profile, retained]) });
  const root = createRoot(container as unknown as Element);
  let unmounted = false;
  let finishRemoval!: (value: boolean) => void;
  let failRemoval!: (reason: Error) => void;
  const invoke = vi.fn((command: string) => {
    if (command === "agent_account_profile_remove") return new Promise<boolean>((resolve, reject) => {
      finishRemoval = resolve;
      failRemoval = reject;
    });
    throw new Error("Unexpected command " + command);
  });
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
  const agents = fakeAgentApi({ catalog: [fakeDefinition({ id: "codex" })] });
  const mcp = {
    daemon: { status: { running: false, mcpOutputScopes: false, shared: [], history: null } },
    setAccess: vi.fn(), pending: new Set(), failures: {}, retry: vi.fn(),
  } as unknown as AgentMcpAccessApi;
  const click = async (label: string) => {
    const button = hostProps(container as unknown as HostNode).find(props => props.children === label && typeof props.onClick === "function");
    expect(button, label).toBeDefined();
    await act(async () => { (button!.onClick as () => unknown)(); await vi.dynamicImportSettled(); });
  };
  try {
    await act(async () => { root.render(<I18nProvider locale="zh-TW"><AgentsView agents={agents} mcp={mcp} remote={fakeRemoteApi()} sandboxAvailable={false} onOpen={vi.fn()} /></I18nProvider>); });
    const select = hostProps(container as unknown as HostNode).find(props => props.className === "select" && props.value === "" && typeof props.onChange === "function");
    expect(select).toBeDefined();
    await act(async () => { (select!.onChange as (event: unknown) => void)({ currentTarget: { value: profile.id } }); });
    await click("移除這個帳號");
    if (mode === "external") saveChatAccountProfiles(localStorage, [profile, retained, concurrent]);
    await click("confirm-removal");
    if (mode === "external") expect(invoke).not.toHaveBeenCalled();
    else expect(invoke).toHaveBeenCalledWith("agent_account_profile_remove", { definitionId: "codex", profileId: "remove" }, undefined);
    if (mode === "unmounted") {
      await act(async () => root.unmount());
      unmounted = true;
    }
    if (mode !== "external") await act(async () => { saveChatAccountProfiles(localStorage, [profile, retained, concurrent]); });
    await act(async () => {
      if (mode === "failed") failRemoval(new Error("Directory is locked"));
      else if (mode !== "external") finishRemoval(true);
    });
    expect(loadChatAccountProfiles(localStorage)).toEqual(mode === "failed" ? [profile, retained, concurrent] : [retained, concurrent]);
  } finally {
    if (!unmounted) await act(async () => root.unmount());
    restoreStorage();
  }
});
