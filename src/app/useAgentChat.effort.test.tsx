import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { useAgentChat, type AgentChatApi } from "./useAgentChat";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("./notificationSounds", () => ({ playCompletionSound: async () => "disabled" }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it.each([{ effort: "high", expected: "high" }, { effort: "max", expected: "medium" }, { effort: null, expected: "medium" }])(
  "sends the selected account's reasoning effort ($effort), including resetting its default", async ({ effort, expected }) => {
    const container = installFakeDom();
    vi.stubGlobal("addEventListener", () => {});
    vi.stubGlobal("removeEventListener", () => {});
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
    invoke.mockImplementation(async command => {
      if (command === "agent_chat_supported") return ["codex"];
      if (command === "agent_chat_models") return [{ value: "account-model", isDefault: true,
        efforts: [{ value: "medium" }, { value: "high" }], defaultEffort: "medium" }];
    });
    let chat!: AgentChatApi;
    function Probe() { chat = useAgentChat(); return null; }
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<Probe />));
      let id = "";
      await act(async () => { id = chat.createThread({ definitionId: "codex", model: "account-model", permission: "ask", workingDirectory: "", effort }).id; });
      await act(async () => chat.send(id, "Synthetic prompt", [], "/synthetic/account"));
      expect(invoke).toHaveBeenCalledWith("agent_chat_models", { definitionId: "codex", profileConfigPath: "/synthetic/account" });
      expect(invoke).toHaveBeenCalledWith("agent_chat_send", expect.objectContaining({ request: expect.objectContaining({ effort: expected, profileConfigPath: "/synthetic/account" }) }));
    } finally { await act(async () => root.unmount()); }
  });
