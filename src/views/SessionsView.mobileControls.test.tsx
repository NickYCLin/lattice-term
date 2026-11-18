import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { fakeAgentApi, fakeSession, installFakeStorage } from "../app/testFixtures/agentApis";
import { allNodes, installHostDom, props } from "../components/agents/testFixtures/interactionDom";
import { SessionsView } from "./SessionsView";
const picker = vi.hoisted(() => vi.fn(async () => "/synthetic/new"));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/synthetic", downloadDir: async () => "/synthetic/downloads", join: async (...parts: string[]) => parts.join("/") }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => [] }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: picker }));
vi.mock("../components/overlays/modalFocus", () => ({ useModalFocus: () => {} }));
vi.mock("../components/agents/AgentTerminalPane", () => ({ AgentTerminalPane: () => null }));
vi.mock("../components/terminal/TerminalPane", () => ({ TerminalPane: () => null }));
vi.mock("../components/sftp/SftpPane", () => ({ SftpPane: () => null }));
vi.mock("../components/connections/HostMetricsPanel", () => ({ HostMetricsPanel: () => null, CompactHostMetrics: () => null }));
vi.mock("../components/icons", async original => Object.fromEntries(Object.keys(await original<Record<string, unknown>>()).map(name => [name, () => null])));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it.each(["agent", "ssh"])("runs every %s mobile session header action without pointer focus theft", async kind => {
  const host = installHostDom();
  vi.stubGlobal("requestAnimationFrame", () => 1); vi.stubGlobal("cancelAnimationFrame", () => {});
  const create = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((...args) => Object.assign(create(...args), { style: { setProperty() {} } }));
  const restore = installFakeStorage();
  Object.assign(window, { localStorage, innerWidth: 390, innerHeight: 844 });
  const root = createRoot(host as unknown as Element);
  const agents = fakeAgentApi({ sessions: kind === "agent" ? [fakeSession()] : [] });
  const empty = { sessions: [], lastClosed: null };
  const disconnect = vi.fn(async () => {}), attachToSsh = vi.fn(async () => ({ outcome: "connected", session: { sessionId: "sftp-fixture" } }));
  const onSelect = vi.fn(), onOpenInChat = vi.fn();
  const view = { agents, ssh: kind === "ssh" ? { ...empty, disconnect, sessions: [{ sessionId: "ssh-fixture", profileId: "synthetic", host: "192.0.2.1", port: 22, username: "fixture" }] } : empty,
    sftp: { ...empty, sessions: [{ sessionId: "sftp-fixture" }], attachToSsh }, remote: empty, rdp: empty, vnc: empty,
    activeSessionId: kind === "agent" ? "s1" : "ssh-fixture", onSelect, onOpenInChat, mobile: true,
    theme: "dark", sessionRestoreComplete: true, restoredWorkspaceSessions: [], unrestoredWorkspaceSessions: [] } as unknown as Parameters<typeof SessionsView>[0];
  const header = () => allNodes(host).find(n => props(n)?.className === "session-header")!;
  const button = (label: string) => allNodes(header()).find(n => props(n)?.["aria-label"] === label)!;
  async function tap(label: string) {
    const target = button(label); expect(target, label).toBeDefined();
    const focused = document.activeElement;
    const preventDefault = vi.fn();
    props(header()).onPointerDown({ target: { closest: () => target }, preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(focused);
    await act(async () => props(target).onClick());
  }
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><SessionsView {...view} /></I18nProvider>));
    await tap("專案與工作階段");
    expect(allNodes(host).some(n => props(n)?.id === "session-project-sidebar" && props(n).role === "dialog")).toBe(true);
    if (kind === "agent") {
      await tap("在對話頁開啟這段對話"); expect(onOpenInChat).toHaveBeenCalledExactlyOnceWith("s1");
      await tap("更換工作目錄"); expect(picker).toHaveBeenCalled();
      expect(allNodes(host).some(n => n.textContent.includes("/synthetic/new"))).toBe(true);
      expect(agents.launch).not.toHaveBeenCalled();
      await tap("重新命名工作階段");
      const input = allNodes(host).find(n => props(n)?.className === "session-header__rename")!;
      await act(async () => props(input).onChange({ currentTarget: { value: "Synthetic renamed" } }));
      await act(async () => props(input).onKeyDown({ key: "Enter", preventDefault: vi.fn() }));
      expect(agents.rename).toHaveBeenCalledWith("s1", "Synthetic renamed");
    } else {
      const initiallyOpen = props(button("開啟檔案總管（SFTP）"))["aria-pressed"];
      await tap("開啟檔案總管（SFTP）");
      expect(props(button("開啟檔案總管（SFTP）"))["aria-pressed"]).toBe(!initiallyOpen);
      if (initiallyOpen) await tap("開啟檔案總管（SFTP）");
      expect(attachToSsh).toHaveBeenCalledWith("ssh-fixture");
      expect(props(button("開啟檔案總管（SFTP）"))["aria-pressed"]).toBe(true);
    }
    await tap("中斷連線");
    expect(kind === "agent" ? agents.disconnect : disconnect).toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith(null);
  } finally { await act(async () => root.unmount()); restore(); }
});
