import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type {
  RemoteHostApi,
  RemoteHostStartRequest,
  RemoteHostStatus,
} from "../../app/useRemoteHost";
import type { SavedCredentialState } from "../../app/useSavedCredential";
import { RemoteHostDialog } from "./RemoteHostDialog";

vi.mock("../overlays/modalFocus", () => ({ useModalFocus: () => {} }));

const credential = vi.hoisted(() => ({
  state: {
    mode: "missing",
    provider: "Secret Service",
    detail: null,
  } as SavedCredentialState,
  refresh: vi.fn(async () => {}),
}));

vi.mock("../../app/useSavedCredential", () => ({
  REMOTE_HOST_CREDENTIAL_ID: "remote-host",
  useSavedCredential: () => ({
    state: credential.state,
    refresh: credential.refresh,
    remove: vi.fn(async () => {}),
  }),
}));

// React host tree, following the editor interaction tests. Native activation
// runs after the click handler and sees the button's post-render form/type.
class HostNode {
  nodeType = 1;
  namespaceURI = "http://www.w3.org/1999/xhtml";
  childNodes: HostNode[] = [];
  parentNode: HostNode | null = null;
  style = {};
  attributes: Record<string, string> = {};
  value = "";
  defaultValue = "";
  ownerDocument: Record<string, unknown>;
  private text = "";
  constructor(readonly tagName: string, document: Record<string, unknown>) {
    this.ownerDocument = document;
  }
  get nodeName() { return this.tagName; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get textContent(): string { return this.text + this.childNodes.map((child) => child.textContent).join(""); }
  set textContent(value: string) { this.text = value; this.childNodes = []; }
  appendChild(child: HostNode) { this.childNodes.push(child); child.parentNode = this; return child; }
  removeChild(child: HostNode) { this.childNodes = this.childNodes.filter((node) => node !== child); child.parentNode = null; return child; }
  insertBefore(child: HostNode, before: HostNode) { this.childNodes.splice(this.childNodes.indexOf(before), 0, child); child.parentNode = this; return child; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  setAttributeNS(_namespace: string, name: string, value: string) { this.setAttribute(name, value); }
  getAttributeNames() { return Object.keys(this.attributes); }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  hasAttribute(name: string) { return name in this.attributes; }
  removeAttribute(name: string) { delete this.attributes[name]; }
  addEventListener() {}
  removeEventListener() {}
  focus() {}
}

function allNodes(node: HostNode): HostNode[] {
  return [node, ...node.childNodes.flatMap(allNodes)];
}

interface Activation { defaultPrevented: boolean; preventDefault(): void }
interface Props {
  type?: string;
  checked?: boolean;
  disabled?: boolean;
  onClick?: (event: Activation) => void;
  onSubmit?: (event: Activation) => Promise<void>;
  onChange?: (event: {
    currentTarget: { checked: boolean; value?: string };
  }) => void;
}
function props(node: HostNode): Props {
  const key = Object.keys(node).find(name => name.startsWith("__reactProps$"))!;
  return (node as unknown as Record<string, Props>)[key];
}
afterEach(() => {
  vi.unstubAllGlobals();
  credential.state = {
    mode: "missing",
    provider: "Secret Service",
    detail: null,
  };
  credential.refresh.mockReset();
  credential.refresh.mockResolvedValue(undefined);
});

function installHostDom() {
  const document: Record<string, unknown> = {
    nodeType: 9,
    activeElement: null,
    addEventListener() {},
    removeEventListener() {},
  };
  document.createElement = (name: string) => new HostNode(name.toUpperCase(), document);
  document.createElementNS = (_namespace: string, name: string) => new HostNode(name.toUpperCase(), document);
  document.createTextNode = (text: string) => {
    const node = new HostNode("#text", document);
    node.nodeType = 3;
    node.textContent = text;
    return node;
  };
  const container = new HostNode("DIV", document);
  document.body = container;
  document.documentElement = container;
  const localStorage = {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  };
  const window = {
    document,
    HTMLIFrameElement: class {},
    localStorage,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
  };
  document.defaultView = window;
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("HTMLElement", HostNode);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return { container };
}

const relayConfiguration = (
  useSavedPairingCode: boolean,
): RemoteHostStartRequest => ({
  bindAddress: "",
  port: 44900,
  fps: 5,
  allowInput: false,
  allowCommands: false,
  allowChat: false,
  allowCli: false,
  allowFiles: false,
  fileRoot: "",
  mode: "relay",
  relayAddress: "wss://relay.example.test",
  pairingCode: "",
  useSavedPairingCode,
  rememberPairingCode: false,
});

const waitingStatus = (savedPairingCode: boolean): RemoteHostStatus => ({
  hostId: "host-test",
  address: "wss://relay.example.test",
  pairingCode: "",
  expiresAt: 0,
  viewOnly: true,
  fileTransfer: false,
  state: "waiting",
  attemptsRemaining: 5,
  persistent: true,
  savedPairingCode,
});

async function mountDialog(host: RemoteHostApi) {
  const { container } = installHostDom();
  const root = createRoot(container as unknown as Element);
  await act(async () => {
    root.render(
      <I18nProvider locale="zh-TW">
        <RemoteHostDialog
          host={host}
          platform="windows"
          sensitiveClipboardClear="off"
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );
  });
  return {
    container,
    root,
    find: (tag: string, text = "") =>
      allNodes(container).find(
        (node) => node.tagName === tag && node.textContent.includes(text),
      ),
    findById: (id: string) =>
      allNodes(container).find((node) => node.attributes.id === id),
  };
}

function hostForForm(useSavedPairingCode: boolean): RemoteHostApi {
  const result = waitingStatus(true);
  return {
    deviceId: "123456789",
    deviceIdError: null,
    ensureDeviceId: vi.fn(async () => {}),
    configuration: relayConfiguration(useSavedPairingCode),
    status: null,
    closedReason: null,
    start: vi.fn(async () => result),
    removeSavedPairingCode: vi.fn(async () => {}),
    retrySavedPairingCodeCleanup: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    clearClosedReason: vi.fn(),
  };
}

it("grants one Fleet workspace explicitly and resets its authority after starting", async () => {
  const host = hostForForm(true);
  const view = await mountDialog(host);
  const input = (label: string) => allNodes(view.find("LABEL", label)!).find(node => node.tagName === "INPUT")!;
  try {
    expect(props(input("分享 Agent Fleet 工作區")).checked).toBe(false);
    await act(async () => { props(input("分享 Agent Fleet 工作區")).onChange!({ currentTarget: { checked: true } }); });
    await act(async () => { props(input("此主機的工作區目錄")).onChange!({ currentTarget: { checked: false, value: "C:\\fixture\\project" } }); });
    await act(async () => { await props(view.find("FORM")!).onSubmit!({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }); });
    expect(host.start).toHaveBeenCalledWith(expect.objectContaining({ fleet: { directory: "C:\\fixture\\project", read: false, control: false, launch: false }, allowCli: false, allowChat: false }));
    expect(props(input("分享 Agent Fleet 工作區")).checked).toBe(false);
  } finally { await act(async () => { view.root.unmount(); }); }
});

it("shows a helpful relay lookup error from a failed save and reveals the address", async () => {
  const host = hostForForm(false);
  host.start = vi.fn(async () => {
    throw new Error("relay: I/O error: No such host is known (os error 11001)");
  });
  const { root, find, findById } = await mountDialog(host);
  try {
    await act(async () => {
      await props(find("FORM")!).onSubmit!({
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
      });
    });
    expect(find("DIV", "找不到中繼伺服器")).toBeDefined();
    expect(findById("remote-host-relay")).toBeDefined();
    expect(find("DIV", "os error 11001")).toBeUndefined();
  } finally {
    await act(async () => { root.unmount(); });
  }
});

it("opens permissions without immediately submitting the newly rendered save action", async () => {
  const host: RemoteHostApi = {
    deviceId: null, deviceIdError: null, ensureDeviceId: vi.fn(async () => {}),
    status: { hostId: "owned-test", address: "127.0.0.1:44900", pairingCode: "", expiresAt: 0, viewOnly: true, fileTransfer: false, state: "waiting", attemptsRemaining: 5, persistent: true, savedPairingCode: false },
    closedReason: null, start: vi.fn(async () => host.status!), removeSavedPairingCode: vi.fn(async () => {}), retrySavedPairingCodeCleanup: vi.fn(async () => {}), stop: vi.fn(async () => {}), clearClosedReason: vi.fn(),
  };
  const { root, find } = await mountDialog(host);
  try {
    const edit = find("BUTTON", "連線與權限設定")!;
    const activation: Activation = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    await act(async () => { props(edit).onClick!(activation); });
    // The old DOM node became type=submit during the click. A browser then
    // submitted immediately, restarting sharing and hiding its permissions.
    if (!activation.defaultPrevented && edit.parentNode && props(edit).type === "submit") {
      await act(async () => { await props(find("FORM")!).onSubmit!(activation); });
    }
    expect(host.start).not.toHaveBeenCalled();
    const grant = find("LABEL", "分享對話並允許操作")!;
    expect(grant).toBeDefined();
    const input = allNodes(grant).find(node => node.tagName === "INPUT")!;
    await act(async () => { props(input).onChange!({ currentTarget: { checked: true } }); });
    const cliGrant = find("LABEL", "分享 CLI 並允許操作")!;
    const cliInput = allNodes(cliGrant).find(node => node.tagName === "INPUT")!;
    await act(async () => { props(cliInput).onChange!({ currentTarget: { checked: true } }); });
    expect(host.start).not.toHaveBeenCalled();
    expect(props(find("BUTTON", "儲存設定")!).type).toBe("submit");
    await act(async () => { await props(find("FORM")!).onSubmit!({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }); });
    expect(host.start).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ allowChat: true, allowCli: true, allowInput: false, allowCommands: false }));
    expect(find("FORM")).toBeUndefined();
  } finally { await act(async () => { root.unmount(); }); }
});

it.each([
  {
    mode: "missing" as const,
    state: {
      mode: "missing" as const,
      provider: "Secret Service",
      detail: null,
    },
  },
  {
    mode: "unavailable" as const,
    state: {
      mode: "unavailable" as const,
      provider: "Encrypted vault",
      detail: "the vault is locked",
      runtimeUnavailable: false,
    },
  },
])("keeps saved-password startup fail-closed when the credential probe is $mode", async ({ state }) => {
  credential.state = state;
  const host = hostForForm(true);
  const { root, find, findById } = await mountDialog(host);
  try {
    expect(findById("remote-host-fixed-code")).toBeUndefined();
    const form = find("FORM")!;
    await act(async () => {
      await props(form).onSubmit!({
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
      });
    });
    expect(host.start).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        pairingCode: "",
        useSavedPairingCode: true,
        rememberPairingCode: false,
      }),
    );
  } finally {
    await act(async () => { root.unmount(); });
  }
});

it("can revoke host-password authority while its secure store is unavailable", async () => {
  credential.state = {
    mode: "unavailable",
    provider: "Encrypted vault",
    detail: "the vault is locked",
    runtimeUnavailable: false,
  };
  const host = hostForForm(true);
  const { root, find } = await mountDialog(host);
  try {
    const remove = find("BUTTON", "刪除已保存密碼")!;
    expect(remove).toBeDefined();
    await act(async () => {
      props(remove).onClick!({
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.removeSavedPairingCode).toHaveBeenCalledOnce();
    expect(credential.refresh).toHaveBeenCalledOnce();
  } finally {
    await act(async () => { root.unmount(); });
  }
});

it("ignores hidden invalid fixed text after switching back to the saved password", async () => {
  credential.state = {
    mode: "saved",
    provider: "Secret Service",
    detail: null,
  };
  const host = hostForForm(false);
  const { root, find, findById } = await mountDialog(host);
  try {
    const password = findById("remote-host-fixed-code")!;
    await act(async () => {
      props(password).onChange!({
        currentTarget: { checked: false, value: "invalid password" },
      });
    });
    const savedChoice = find(
      "LABEL",
      "使用安全儲存區中已保存的主機密碼",
    )!;
    const savedCheckbox = allNodes(savedChoice).find(
      (node) => node.tagName === "INPUT",
    )!;
    await act(async () => {
      props(savedCheckbox).onChange!({
        currentTarget: { checked: true, value: "" },
      });
    });
    expect(findById("remote-host-fixed-code")).toBeUndefined();

    await act(async () => {
      await props(find("FORM")!).onSubmit!({
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
      });
    });
    expect(host.start).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        pairingCode: "",
        useSavedPairingCode: true,
        rememberPairingCode: false,
      }),
    );
  } finally {
    await act(async () => { root.unmount(); });
  }
});

it("requires an explicit remember choice after a password is entered", async () => {
  credential.state = {
    mode: "missing",
    provider: "Secret Service",
    detail: null,
  };
  const host = hostForForm(false);
  const { root, find, findById } = await mountDialog(host);
  try {
    const rememberLabel = find(
      "LABEL",
      "啟動成功後保存到 Secret Service",
    )!;
    let rememberCheckbox = allNodes(rememberLabel).find(
      (node) => node.tagName === "INPUT",
    )!;
    expect(props(rememberCheckbox).checked).toBe(false);
    expect(props(rememberCheckbox).disabled).toBe(true);

    const password = findById("remote-host-fixed-code")!;
    await act(async () => {
      props(password).onChange!({
        currentTarget: { checked: false, value: "correct-horse" },
      });
    });
    rememberCheckbox = allNodes(
      find("LABEL", "啟動成功後保存到 Secret Service")!,
    ).find((node) => node.tagName === "INPUT")!;
    expect(props(rememberCheckbox).checked).toBe(false);
    expect(props(rememberCheckbox).disabled).toBe(false);
    await act(async () => {
      props(rememberCheckbox).onChange!({
        currentTarget: { checked: true, value: "" },
      });
    });

    await act(async () => {
      await props(find("FORM")!).onSubmit!({
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
      });
    });
    expect(host.start).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        pairingCode: "correct-horse",
        useSavedPairingCode: false,
        rememberPairingCode: true,
      }),
    );
  } finally {
    await act(async () => { root.unmount(); });
  }
});

it("retries a pending secure cleanup and refreshes its visible state", async () => {
  credential.state = {
    mode: "missing",
    provider: "Encrypted vault",
    detail: null,
    cleanupPending: true,
  };
  const host = hostForForm(false);
  const { root, find } = await mountDialog(host);
  try {
    const retry = find("BUTTON", "重試安全清理")!;
    expect(retry).toBeDefined();
    await act(async () => {
      props(retry).onClick!({
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.retrySavedPairingCodeCleanup).toHaveBeenCalledOnce();
    expect(credential.refresh).toHaveBeenCalledOnce();
  } finally {
    await act(async () => { root.unmount(); });
  }
});

it("shows an active password as current-run only after deleting its saved copy", async () => {
  credential.state = {
    mode: "saved",
    provider: "Secret Service",
    detail: null,
  };
  credential.refresh.mockImplementation(async () => {
    credential.state = {
      mode: "missing",
      provider: "Secret Service",
      detail: null,
    };
  });
  const host: RemoteHostApi = {
    deviceId: "123456789",
    deviceIdError: null,
    ensureDeviceId: vi.fn(async () => {}),
    configuration: relayConfiguration(true),
    status: waitingStatus(true),
    closedReason: null,
    start: vi.fn(async () => host.status!),
    removeSavedPairingCode: vi.fn(async () => {
      host.status = waitingStatus(false);
      host.configuration = relayConfiguration(false);
    }),
    retrySavedPairingCodeCleanup: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    clearClosedReason: vi.fn(),
  };
  const first = await mountDialog(host);
  let firstMounted = true;
  let second: Awaited<ReturnType<typeof mountDialog>> | null = null;
  try {
    expect(first.find("SPAN", "密碼已保存")).toBeDefined();
    await act(async () => {
      props(first.find("BUTTON", "連線與權限設定")!).onClick!({
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
      });
    });
    await act(async () => {
      props(first.find("BUTTON", "刪除已保存密碼")!).onClick!({
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.removeSavedPairingCode).toHaveBeenCalledOnce();
    await act(async () => { first.root.unmount(); });
    firstMounted = false;

    second = await mountDialog(host);
    expect(second.find("SPAN", "密碼已保存")).toBeUndefined();
    expect(
      second.find("SPAN", "目前密碼只在本次分享期間有效"),
    ).toBeDefined();
  } finally {
    if (firstMounted) await act(async () => { first.root.unmount(); });
    if (second) await act(async () => { second!.root.unmount(); });
  }
});
