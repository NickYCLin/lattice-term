import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConnectionProfile } from "../../domain/connection";
import type { SavedCredentialState } from "../../app/useSavedCredential";
import type { VaultApi } from "../../app/useVault";
import type { RemoteApi } from "../../app/useRemoteSessions";
import { I18nProvider } from "../../i18n";
import { RemoteConnectFlow } from "./RemoteConnectFlow";

vi.mock("../overlays/modalFocus", () => ({ useModalFocus: () => {} }));
const credential = vi.hoisted(() => ({
  state: { mode: "unavailable", provider: "Encrypted vault", detail: "the vault is locked", runtimeUnavailable: false } as SavedCredentialState,
  refresh: vi.fn(async () => {}), remove: vi.fn(async () => {}),
}));
vi.mock("../../app/useSavedCredential", () => ({ useSavedCredential: () => credential }));

class HostNode {
  nodeType = 1;
  namespaceURI = "http://www.w3.org/1999/xhtml";
  childNodes: HostNode[] = [];
  parentNode: HostNode | null = null;
  style = {};
  attributes: Record<string, string> = {};
  value = "";
  defaultValue = "";
  private text = "";
  constructor(readonly tagName: string, readonly ownerDocument: Record<string, unknown>) {}
  get nodeName() { return this.tagName; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get textContent(): string { return this.text + this.childNodes.map(child => child.textContent).join(""); }
  set textContent(value: string) { this.text = value; this.childNodes = []; }
  appendChild(child: HostNode) { this.childNodes.push(child); child.parentNode = this; return child; }
  removeChild(child: HostNode) { this.childNodes = this.childNodes.filter(node => node !== child); child.parentNode = null; return child; }
  insertBefore(child: HostNode, before: HostNode) { this.childNodes.splice(this.childNodes.indexOf(before), 0, child); child.parentNode = this; return child; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  removeAttribute(name: string) { delete this.attributes[name]; }
  addEventListener() {}
  removeEventListener() {}
  focus() {}
}
function allNodes(node: HostNode): HostNode[] { return [node, ...node.childNodes.flatMap(allNodes)]; }
interface Props {
  type?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  onChange?: (event: { currentTarget: { value: string; checked: boolean } }) => void;
  onClick?: () => void;
  onSubmit?: (event: { preventDefault: () => void }) => Promise<void>;
  onKeyDown?: (event: { key: string; nativeEvent: { isComposing: boolean }; preventDefault: () => void; stopPropagation: () => void }) => void;
}
function props(node: HostNode): Props {
  const key = Object.keys(node).find(name => name.startsWith("__reactProps$"))!;
  return (node as unknown as Record<string, Props>)[key];
}
function installHostDom() {
  const document: Record<string, unknown> = { nodeType: 9, activeElement: null, addEventListener() {}, removeEventListener() {} };
  document.createElement = (name: string) => new HostNode(name.toUpperCase(), document);
  document.createElementNS = (_namespace: string, name: string) => new HostNode(name.toUpperCase(), document);
  document.createTextNode = (text: string) => { const node = new HostNode("#text", document); node.nodeType = 3; node.textContent = text; return node; };
  const container = new HostNode("DIV", document);
  document.body = container;
  document.documentElement = container;
  const window = { document, HTMLIFrameElement: class {} };
  document.defaultView = window;
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("HTMLElement", HostNode);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return container;
}
const profile: ConnectionProfile = { id: "test-device", name: "Test device", protocol: "lattice", hostname: "", username: "",
  port: 0, environment: "unassigned", group: "Remote", tags: [], favorite: false, deviceId: "123456789", relayAddress: "wss://relay.example.test" };
function fakeVault(state: "locked" | "notCreated" | "unlocked" = "locked"): VaultApi {
  return { status: { state, entryCount: null, path: "/test/vault" }, backend: "vault", problem: null, busy: false,
    refresh: vi.fn(async () => {}), create: vi.fn(async () => true), unlock: vi.fn(async () => true), lock: vi.fn(async () => {}),
    changePassword: vi.fn(async () => true), setBackend: vi.fn(async () => true) };
}
function harness(vault = fakeVault()) {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  const connect = vi.fn(async () => ({ outcome: "connected", sessionId: "test-session" }));
  const connected = vi.fn();
  const render = () => root.render(<I18nProvider locale="zh-TW"><RemoteConnectFlow profile={profile}
    remote={{ connect } as unknown as RemoteApi} vault={vault} onConnected={connected} onCancel={vi.fn()} /></I18nProvider>);
  const input = (id: string) => allNodes(container).find(node => node.attributes.id === id)!;
  const change = async (id: string, value: string) => {
    await act(async () => { const node = input(id); node.value = value; props(node).onChange?.({ currentTarget: { value, checked: false } }); });
  };
  const button = (label: string) => allNodes(container).find(node => node.tagName === "BUTTON" && node.textContent === label)!;
  return { container, root, connect, connected, render, input, change, button, vault };
}
beforeEach(() => {
  credential.state = { mode: "unavailable", provider: "Encrypted vault", detail: "the vault is locked", runtimeUnavailable: false };
  credential.refresh.mockClear();
});
afterEach(() => { vi.unstubAllGlobals(); });

it("unlocks in place without sending a connection or losing the entered pairing code", async () => {
  const test = harness();
  try {
    await act(async () => test.render());
    expect(test.container.textContent).toContain("保管庫目前鎖定");
    expect(test.container.textContent).not.toContain("系統安全儲存區目前無法使用");
    await test.change("remote-pairing-code", "test-pairing-code");
    await test.change("credential-vault-password", "test-only-master");
    const password = test.input("credential-vault-password");
    const preventDefault = vi.fn();
    await act(async () => props(password).onKeyDown!({ key: "Enter", nativeEvent: { isComposing: false }, preventDefault, stopPropagation: vi.fn() }));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(test.vault.unlock).toHaveBeenCalledExactlyOnceWith("test-only-master");
    expect(password.value).toBe("");
    expect(test.connect).not.toHaveBeenCalled();
    expect(props(test.input("remote-pairing-code")).value).toBe("test-pairing-code");
    test.vault.status = { state: "unlocked", entryCount: 0, path: "/test/vault" };
    credential.state = { mode: "missing", provider: "Encrypted vault", detail: null };
    await act(async () => test.render());
    expect(test.container.textContent).toContain("成功配對後將配對碼保存到 Encrypted vault");
    const remember = allNodes(test.container).find(node => node.tagName === "INPUT" && props(node).type === "checkbox")!;
    await act(async () => props(remember).onChange!({ currentTarget: { checked: true, value: "" } }));
    await act(async () => props(allNodes(test.container).find(node => node.tagName === "FORM")!).onSubmit!({ preventDefault: vi.fn() }));
    expect(test.connect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ profileId: profile.id,
      pairingCode: "test-pairing-code", rememberPairingCode: true, useSavedPairingCode: false }));
    expect(test.connected).toHaveBeenCalledExactlyOnceWith("test-session");
  } finally { await act(async () => test.root.unmount()); }
});

it("keeps a failed unlock locked and clears the master password", async () => {
  const test = harness();
  vi.mocked(test.vault.unlock).mockResolvedValue(false);
  try {
    await act(async () => test.render());
    await test.change("credential-vault-password", "test-only-invalid");
    await act(async () => props(test.button("解鎖")).onClick!());
    expect(test.input("credential-vault-password").value).toBe("");
    expect(test.container.textContent).toContain("保管庫目前鎖定");
    expect(test.container.textContent).not.toContain("成功配對後將配對碼保存");
    expect(test.connect).not.toHaveBeenCalled();
    expect(credential.refresh).toHaveBeenCalledTimes(1);
  } finally { await act(async () => test.root.unmount()); }
});

it("creates a vault only after matching master passwords and never submits the outer connection form", async () => {
  const test = harness(fakeVault("notCreated"));
  try {
    await act(async () => test.render());
    expect(test.container.textContent).toContain("尚未建立");
    await test.change("credential-vault-password", "test-only-master");
    await test.change("credential-vault-confirm", "test-only-other");
    await act(async () => props(test.button("建立保管庫")).onClick!());
    expect(test.vault.create).not.toHaveBeenCalled();
    expect(test.container.textContent).toContain("兩次輸入的密碼不一樣");
    expect(test.input("credential-vault-password").value).toBe("");
    expect(test.input("credential-vault-confirm").value).toBe("");
    await test.change("credential-vault-password", "test-only-master");
    await test.change("credential-vault-confirm", "test-only-master");
    await act(async () => props(test.button("建立保管庫")).onClick!());
    expect(test.vault.create).toHaveBeenCalledExactlyOnceWith("test-only-master");
    expect(test.connect).not.toHaveBeenCalled();
    expect(test.input("credential-vault-confirm").value).toBe("");
  } finally { await act(async () => test.root.unmount()); }
});

it("reuses an existing saved pairing code once without exposing its value", async () => {
  const test = harness(fakeVault("unlocked"));
  credential.state = { mode: "saved", provider: "Encrypted vault", detail: null };
  try {
    await act(async () => test.render());
    await act(async () => test.render());
    expect(test.connect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ pairingCode: "", useSavedPairingCode: true, rememberPairingCode: false }));
    expect(test.container.textContent).toContain("配對碼已安全保存");
  } finally { await act(async () => test.root.unmount()); }
});

it("does not request storage after the vault locks while a remember choice is selected", async () => {
  const test = harness(fakeVault("unlocked"));
  credential.state = { mode: "missing", provider: "Encrypted vault", detail: null };
  try {
    await act(async () => test.render());
    await test.change("remote-pairing-code", "test-pairing-code");
    const remember = allNodes(test.container).find(node => node.tagName === "INPUT" && props(node).type === "checkbox")!;
    await act(async () => props(remember).onChange!({ currentTarget: { checked: true, value: "" } }));
    test.vault.status = { state: "locked", entryCount: null, path: "/test/vault" };
    await act(async () => test.render());
    await act(async () => props(allNodes(test.container).find(node => node.tagName === "FORM")!).onSubmit!({ preventDefault: vi.fn() }));
    expect(test.connect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ rememberPairingCode: false, useSavedPairingCode: false }));
  } finally { await act(async () => test.root.unmount()); }
});
