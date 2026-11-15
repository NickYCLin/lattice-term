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

it.each([
  { reported: ["claude", "codex", "gemini", "antigravity", "unknown-cli"], expected: ["claude", "codex", "gemini", "antigravity"] },
  { reported: ["antigravity"], expected: ["antigravity"] },
  { reported: ["codex"], expected: ["codex"] },
])("keeps known chat backends from the native catalog: $reported", async ({ reported, expected }) => {
  const container = installFakeDom();
  vi.stubGlobal("addEventListener", () => {});
  vi.stubGlobal("removeEventListener", () => {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
  let resolveSupported!: (ids: string[]) => void;
  const supported = new Promise<string[]>(resolve => { resolveSupported = resolve; });
  invoke.mockImplementation(async command => command === "agent_chat_supported" ? supported : undefined);
  let chat!: AgentChatApi;
  function Probe() { chat = useAgentChat(); return null; }
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<Probe />));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("agent_chat_supported"));
    await act(async () => { resolveSupported(reported); await supported; });
    expect(chat.supported).toEqual(expected);
  } finally {
    await act(async () => root.unmount());
  }
});

it("defaults browser and sharing only for newly created desktop conversations", async () => {
  const { desktopChatAccess: access } = await import("./desktopChat");
  const container = installFakeDom();
  vi.stubGlobal("addEventListener", () => {});
  vi.stubGlobal("removeEventListener", () => {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
  invoke.mockResolvedValue([]);
  let chat!: AgentChatApi;
  function Probe() { chat = useAgentChat(); return null; }
  const root = createRoot(container as unknown as Element);
  access.reset(null);
  try {
    await act(async () => { root.render(<Probe />); });
    await act(async () => {
      const enabled = chat.createThread({ definitionId: "claude", workingDirectory: "/work", model: "", permission: "ask" });
      expect(enabled.browserEnabled).toBe(true);
      expect(access.defaultShares.has(enabled.id)).toBe(true);
      const disabled = chat.createThread({ definitionId: "codex", workingDirectory: "/work", model: "", permission: "ask", browserEnabled: false });
      expect(disabled.browserEnabled).toBe(false);
      const unsupported = chat.createThread({ definitionId: "gemini", workingDirectory: "/work", model: "", permission: "ask" });
      expect(unsupported.browserEnabled).toBe(false);
    });
  } finally { await act(async () => { root.unmount(); }); access.reset(null); }
});
