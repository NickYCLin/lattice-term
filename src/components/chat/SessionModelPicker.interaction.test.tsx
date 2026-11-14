import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { allNodes, installHostDom, props } from "../agents/testFixtures/interactionDom";
import { fakeAgentApi, fakeSession } from "../../app/testFixtures/agentApis";
import { I18nProvider } from "../../i18n";
import { SessionModelPicker } from "./SessionModelPicker";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../../app/nativeRuntime", () => ({ hasDesktopBackend: () => true }));
vi.mock("../../app/useCliProxyApi", () => ({
  useCliProxySettings: () => ({ proxies: [] }),
  useCliProxyModels: () => ({ state: "idle" }),
}));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("opens the model menu during a running turn and permits switching once the session is ready", async () => {
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  const session = fakeSession({ sessionId: "current", model: "old-model", capturedSessionId: "native",
    state: "working", stateSource: "integration", profileConfigPath: "/synthetic/account" });
  const agents = fakeAgentApi({ launch: vi.fn().mockResolvedValue(fakeSession({ sessionId: "replacement", model: "new-model" })) });
  const replaced = vi.fn();
  invoke.mockResolvedValue([{ value: "old-model", label: "Old model" }, { value: "new-model", label: "New model" }]);
  const render = (disabled: boolean) => <I18nProvider locale="zh-TW"><SessionModelPicker
    session={session} agents={agents} disabled={disabled} onNotice={() => {}} onReplaced={replaced} /></I18nProvider>;
  try {
    await act(async () => root.render(render(true)));
    const trigger = allNodes(host).find(node => props(node)?.className === "session-composer__model")!;
    expect(props(trigger).disabled).toBe(false);
    await act(async () => props(trigger).onClick());
    expect(invoke).toHaveBeenCalledWith("agent_chat_models", { definitionId: "codex", profileConfigPath: "/synthetic/account" });
    let choice = allNodes(host).find(node => props(node)?.role === "menuitemradio" && props(node).title === "new-model")!;
    expect(props(choice).disabled).toBe(true);
    expect(host.textContent).toContain("就緒後即可切換");
    expect(agents.disconnect).not.toHaveBeenCalled();
    await act(async () => root.render(render(false)));
    choice = allNodes(host).find(node => props(node)?.role === "menuitemradio" && props(node).title === "new-model")!;
    expect(props(choice).disabled).toBe(false);
    await act(async () => props(choice).onClick());
    expect(agents.launch).toHaveBeenCalledWith(expect.objectContaining({ arguments: ["--model", "new-model"],
      resumeSessionId: "native", profileConfigPath: "/synthetic/account", groupId: session.groupId }));
    expect(replaced).toHaveBeenLastCalledWith("replacement");
  } finally { await act(async () => root.unmount()); }
});
