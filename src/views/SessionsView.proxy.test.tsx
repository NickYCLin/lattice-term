import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { fakeAgentApi, fakeChatApi, fakeAutomationsApi, fakeDefinition, fakeThread, installFakeStorage } from "../app/testFixtures/agentApis";
import { installFakeDom } from "../app/testFixtures/hookDom";
import { CLI_PROXY_SETTINGS_KEY } from "../app/cliProxyApi";
import { SessionsView } from "./SessionsView";
import { ChatView } from "./ChatView";
import { sessionPermissionArguments, type SessionPermission } from "../app/sessionPermissions";

vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "C:/Users/test", downloadDir: async () => "C:/Downloads", join: async (...parts: string[]) => parts.join("/") }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => [] }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => "D:/project/test" }));
vi.mock("../components/overlays/modalFocus", () => ({ useModalFocus: () => {} }));
vi.mock("../components/icons", async importOriginal => {
  const icons = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(Object.keys(icons).map(name => [name, () => null]));
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

type TestNode = { childNodes?: TestNode[]; [key: string]: unknown };
function elements(node: TestNode): TestNode[] {
  return [node, ...(node.childNodes ?? []).flatMap(elements)];
}
function props(node: TestNode): Record<string, any> {
  const key = Object.keys(node).find(name => name.startsWith("__reactProps$"));
  return key ? node[key] as Record<string, any> : {};
}

it.each([
  { catalog: [], direct: true, folder: false, permission: "default" },
  { catalog: [fakeDefinition({ installed: false, installedPath: null })], direct: true, folder: false, permission: "default" },
  { catalog: [fakeDefinition({ id: "claude", label: "Claude Code" })], direct: true, folder: false, permission: "default" },
  { catalog: [fakeDefinition()], direct: false, folder: false, permission: "default" },
  { catalog: [fakeDefinition()], direct: false, folder: false, permission: "full" },
  { catalog: [fakeDefinition()], direct: false, folder: false, permission: "readOnly" },
  { catalog: [], direct: true, folder: true, permission: "default" },
])("launches the selected proxy from Sessions: folder=$folder, permission=$permission", async ({ catalog, direct, folder, permission }) => {
  const container = installFakeDom();
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((...args) => Object.assign(createElement(...args), { options: [] }));
  vi.stubGlobal("addEventListener", () => {});
  vi.stubGlobal("removeEventListener", () => {});
  const restore = installFakeStorage({ [CLI_PROXY_SETTINGS_KEY]: JSON.stringify({ proxies: [
    { id: "backup", label: "工作代理", baseUrl: "http://localhost:8317" },
  ] }) });
  const root = createRoot(container as unknown as Element);
  const agents = fakeAgentApi({ catalog });
  const onStartApiChat = vi.fn();
  const emptyRemote = { sessions: [], lastClosed: null };
  const viewProps = { agents, ssh: emptyRemote, sftp: emptyRemote, remote: emptyRemote, rdp: emptyRemote,
    vnc: emptyRemote, activeSessionId: null, onSelect: vi.fn(), theme: "dark", sessionRestoreComplete: true,
    restoredWorkspaceSessions: [], unrestoredWorkspaceSessions: [], onStartApiChat } as unknown as Parameters<typeof SessionsView>[0];
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><SessionsView {...viewProps} /></I18nProvider>));
    const quick = elements(container).find(node => String(props(node).className ?? "").includes("button--sm")
      && Array.isArray(props(node).children) && props(node).children.some((child: any) => child?.props?.title === "工作代理"));
    expect(quick).toBeDefined();
    if (folder) {
      const choose = elements(container).find(node => props(node).className === "button button--primary"
        && props(node).children?.includes?.("加入其他本機專案"));
      expect(choose).toBeDefined();
      await act(async () => props(choose!).onClick());
    } else {
      await act(async () => props(quick!).onClick());
    }
    const modelInput = elements(container).find(node => props(node).placeholder === "gpt-5.6-sol");
    expect(modelInput).toBeDefined();
    const launch = () => elements(container).find(node => props(node).className === "button button--primary"
      && props(node).children === (direct ? "新對話" : "啟動工作階段"));
    expect(props(launch()!).disabled).toBe(true);
    await act(async () => props(modelInput!).onChange({ currentTarget: { value: "invalid model" } }));
    expect(props(launch()!).disabled).toBe(true);
    await act(async () => props(launch()!).onClick());
    expect(onStartApiChat).not.toHaveBeenCalled();
    expect(agents.launch).not.toHaveBeenCalled();
    await act(async () => props(modelInput!).onChange({ currentTarget: { value: "proxy-model" } }));
    expect(props(launch()!).disabled).toBe(false);
    const permissionSelect = elements(container).find(node => props(node)["aria-describedby"]?.endsWith("-hint")
      && props(node).value === "default" && props(node).onChange);
    if (direct) {
      expect(permissionSelect).toBeUndefined();
    } else {
      expect(permissionSelect).toBeDefined();
      await act(async () => props(permissionSelect!).onChange({ currentTarget: { value: permission } }));
      if (permission === "full") expect(elements(container).some(node => String(props(node).children ?? "").includes("略過工具權限詢問"))).toBe(true);
    }
    await act(async () => props(launch()!).onClick());
    if (direct) {
      expect(onStartApiChat).toHaveBeenCalledExactlyOnceWith({ definitionId: "codex", accountProfileId: null,
        provider: "cliproxyapi", proxyId: "backup", model: "proxy-model" }, folder ? "D:/project/test" : "C:/Users/test");
      expect(agents.launch).not.toHaveBeenCalled();
    } else {
      expect(onStartApiChat).not.toHaveBeenCalled();
      expect(agents.launch).toHaveBeenCalledWith(expect.objectContaining({ definitionId: "codex",
        workingDirectory: folder ? "D:/project/test" : "C:/Users/test",
        arguments: expect.arrayContaining(sessionPermissionArguments("codex", permission as SessionPermission)) }));
      await act(async () => props(quick!).onClick());
      const reopened = elements(container).find(node => props(node)["aria-describedby"]?.endsWith("-hint") && props(node).onChange);
      expect(props(reopened!).value).toBe("default");
    }
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

it.each([
  { previous: undefined, proxyId: "backup", model: "" },
  { previous: fakeThread({ model: "native-model" }), proxyId: "backup", model: "" },
  { previous: fakeThread({ provider: "cliproxyapi", proxyId: "removed", model: "proxy-model" }), proxyId: "backup", model: "proxy-model" },
  { previous: fakeThread({ provider: "cliproxyapi", proxyId: "second", model: "proxy-model" }), proxyId: "second", model: "proxy-model" },
])("starts a proxy-only conversation with the correct endpoint: $proxyId", async ({ previous, proxyId, model }) => {
  const container = installFakeDom();
  vi.stubGlobal("addEventListener", () => {});
  vi.stubGlobal("removeEventListener", () => {});
  const restore = installFakeStorage({ [CLI_PROXY_SETTINGS_KEY]: JSON.stringify({ proxies: [
    { id: "backup", label: "工作代理", baseUrl: "http://localhost:8317" },
    { id: "second", label: "備援代理", baseUrl: "http://localhost:8319" },
  ] }) });
  const root = createRoot(container as unknown as Element);
  const chat = fakeChatApi({ supported: [], threads: previous ? [previous] : [] });
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><ChatView chat={chat}
      agents={fakeAgentApi({ catalog: [] })} automations={fakeAutomationsApi()} onOpenSession={() => {}} /></I18nProvider>));
    const create = elements(container).find(node => props(node)["aria-label"] === "新對話");
    expect(create).toBeDefined();
    expect(props(create!).disabled).toBe(false);
    await act(async () => props(create!).onClick());
    expect(chat.createThread).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ definitionId: "codex",
      provider: "cliproxyapi", proxyId, model, accountProfileId: null }));
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});
