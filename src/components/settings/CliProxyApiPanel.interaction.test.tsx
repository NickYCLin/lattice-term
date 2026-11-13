import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { CLI_PROXY_SETTINGS_CHANGED, CLI_PROXY_SETTINGS_KEY } from "../../app/cliProxyApi";
import { installFakeDom } from "../../app/testFixtures/hookDom";
import { CliProxyApiPanel } from "./CliProxyApiPanel";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../../app/useCliProxyApi", () => ({
  useCliProxyModels: () => ({ state: "loading", reload: () => {} }),
}));

type Host = Record<string, unknown> & { childNodes?: Host[] };
type Props = {
  children?: unknown;
  type?: string;
  disabled?: boolean;
  role?: string;
  value?: string;
  onChange?: (event: { currentTarget: { value: string } }) => void;
  onClick?: () => void;
};

function hostProps(node: Host): Props[] {
  const key = Object.keys(node).find(name => name.startsWith("__reactProps$"));
  return [...(key ? [node[key] as Props] : []), ...(node.childNodes ?? []).flatMap(hostProps)];
}

let root: Root | undefined;
let container: Host;
let values: Map<string, string>;

async function mount(baseUrl?: string, hasKey = false, initialKeyRead?: Promise<boolean>) {
  values = new Map(baseUrl ? [[CLI_PROXY_SETTINGS_KEY, JSON.stringify({
    proxies: [{ id: "default", label: "", baseUrl }],
  })]] : []);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  container = installFakeDom();
  vi.stubGlobal("Event", class { constructor(public type: string) {} });
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke: (command: string, args: unknown) => invoke(command, args) });
  document.createElementNS = ((_namespace: string | null, name: string) => document.createElement(name)) as typeof document.createElementNS;
  vi.stubGlobal("dispatchEvent", vi.fn());
  invoke.mockImplementation(async (command: string) => {
    if (command === "cliproxy_key_exists") {
      if (initialKeyRead) {
        const pending = initialKeyRead;
        initialKeyRead = undefined;
        return pending;
      }
      return hasKey;
    }
    if (command === "cliproxy_gemini_auth") return { reachesProxy: true };
    if (command === "cliproxy_save_key") return;
    throw new Error(command);
  });
  root = createRoot(container as unknown as Element);
  await act(async () => root!.render(<I18nProvider locale="en"><CliProxyApiPanel available /></I18nProvider>));
}

function inputs() { return hostProps(container).filter(props => props.onChange); }
function keyInput() { return inputs().find(props => props.type === "password")!; }
function keySave() { return hostProps(container).find(props => props.onClick && props.children === "Save the key")!; }
async function change(input: Props, value: string) {
  expect(input.disabled).toBe(false);
  await act(async () => input.onChange!({ currentTarget: { value } }));
}
async function saveKey() {
  expect(keySave().disabled).toBe(false);
  await act(async () => keySave().onClick!());
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
  invoke.mockReset();
});

it.each([
  { command: "cliproxy_save_key", button: "Save the key", removesFirst: false },
  { command: "cliproxy_probe", button: "Test and save", removesFirst: false },
  { command: "cliproxy_forget_key", button: "Remove this proxy", removesFirst: true },
])("preserves another saved proxy while $command is pending", async ({ command, button, removesFirst }) => {
  await mount("http://127.0.0.1:8317");
  await change(keyInput(), "first-test-key");
  let complete!: (value: unknown) => void;
  const pending = new Promise(resolve => { complete = resolve; });
  invoke.mockImplementationOnce(() => pending);
  const firstAction = hostProps(container).find(props => props.onClick && props.children === button)!;
  expect(firstAction).toBeDefined();
  await act(async () => { firstAction.onClick!(); });
  expect(invoke).toHaveBeenLastCalledWith(command, expect.any(Object));
  const add = hostProps(container).find(props => props.onClick && props.children === "Add a proxy")!;
  await act(async () => add.onClick!());
  await change(inputs()[4], "http://127.0.0.1:9317");
  await change(inputs()[5], "second-test-key");
  const secondSave = hostProps(container).filter(props => props.onClick && props.children === "Save the key")[1];
  await act(async () => secondSave.onClick!());
  await act(async () => { complete({ healthy: true, status: 200 }); await pending; });
  const saved = JSON.parse(values.get(CLI_PROXY_SETTINGS_KEY)!);
  expect(saved.proxies.map((proxy: { baseUrl: string }) => proxy.baseUrl)).toEqual(removesFirst
    ? ["http://127.0.0.1:9317"]
    : ["http://127.0.0.1:8317", "http://127.0.0.1:9317"]);
  expect(inputs()).toHaveLength(removesFirst ? 3 : 6);
  expect(values.get(CLI_PROXY_SETTINGS_KEY)).not.toContain("test-key");
});

it.each([true, false])("ignores an older key lookup after a confirmed key change (key exists: %s)", async hasKey => {
  let complete!: (value: boolean) => void;
  const pending = new Promise<boolean>(resolve => { complete = resolve; });
  await mount("http://127.0.0.1:8317", true, pending);
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("cliproxy_key_exists", { proxyId: "default" }));
  await change(keyInput(), "status-race-test-key");
  await saveKey();
  if (!hasKey) {
    invoke.mockResolvedValueOnce(true);
    const removeKey = hostProps(container).find(props => props.onClick && props.children === "Delete the key")!;
    await act(async () => removeKey.onClick!());
  }
  const canDelete = () => hostProps(container).some(props => props.onClick && props.children === "Delete the key");
  expect(canDelete()).toBe(hasKey);
  await act(async () => { complete(!hasKey); await pending; });
  expect(canDelete()).toBe(hasKey);
});

it("lets a new user enter and save a key without probing the address first", async () => {
  await mount();
  const add = hostProps(container).find(props => props.onClick && props.children === "Add a proxy")!;
  await act(async () => add.onClick!());
  await change(keyInput(), "test-only-key");
  expect(keySave().disabled).toBe(true);
  await change(inputs()[1], "http://127.0.0.1:8317");
  await saveKey();
  expect(invoke).toHaveBeenCalledWith("cliproxy_save_key", {
    proxyId: expect.any(String), baseUrl: "http://127.0.0.1:8317", key: "test-only-key",
  });
  expect(invoke.mock.calls.some(([command]) => command === "cliproxy_probe")).toBe(false);
  expect(values.get(CLI_PROXY_SETTINGS_KEY)).toContain("http://127.0.0.1:8317");
  expect(values.get(CLI_PROXY_SETTINGS_KEY)).not.toContain("test-only-key");
  expect(keyInput().value).toBe("");
});

it.each([true, false])("keeps a confirmed key change usable when status reads fail (saving: %s)", async saving => {
  await mount("http://127.0.0.1:8317", !saving);
  await act(async () => { await vi.dynamicImportSettled(); });
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("cliproxy_key_exists", { proxyId: "default" }));
  invoke.mockImplementation(async (command: string) => {
    if (command === "cliproxy_key_exists") throw new Error("credential status unavailable");
    if (command === "cliproxy_save_key") return;
    if (command === "cliproxy_forget_key") return true;
    throw new Error(command);
  });
  vi.mocked(window.dispatchEvent).mockClear();
  if (saving) {
    await change(keyInput(), "confirmed-test-key");
    await saveKey();
  } else {
    const forget = hostProps(container).find(props => props.onClick && props.children === "Delete the key")!;
    await act(async () => forget.onClick!());
  }
  expect(hostProps(container).filter(props => props.role === "alert")).toEqual([]);
  expect(keyInput().disabled).toBe(false);
  expect(hostProps(container).some(props => props.children === "Delete the key" && props.onClick)).toBe(saving);
  expect(vi.mocked(window.dispatchEvent).mock.calls.some(([event]) => event.type === CLI_PROXY_SETTINGS_CHANGED)).toBe(true);
});

it("allows replacing a stored key and binds it to the address currently shown", async () => {
  await mount("http://127.0.0.1:8317", true);
  await change(inputs()[1], "http://127.0.0.1:9317");
  await change(keyInput(), "replacement-test-key");
  await saveKey();
  expect(invoke).toHaveBeenCalledWith("cliproxy_save_key", {
    proxyId: "default", baseUrl: "http://127.0.0.1:9317", key: "replacement-test-key",
  });
  expect(values.get(CLI_PROXY_SETTINGS_KEY)).toContain("http://127.0.0.1:9317");
  expect(keyInput().value).toBe("");
});

it("preserves the entered key and saved address when credential storage fails", async () => {
  await mount("http://127.0.0.1:8317");
  await change(inputs()[1], "http://127.0.0.1:9317");
  await change(keyInput(), "retry-test-key");
  invoke.mockRejectedValueOnce(new Error("credential store unavailable"));
  await saveKey();
  expect(keyInput().value).toBe("retry-test-key");
  expect(keyInput().disabled).toBe(false);
  expect(values.get(CLI_PROXY_SETTINGS_KEY)).toContain("http://127.0.0.1:8317");
  expect(hostProps(container).some(props => props.children === "Error: credential store unavailable")).toBe(true);
});

it.each([true, false])("keeps the proxy retryable when key deletion fails (stored key: %s)", async hasKey => {
  await mount("http://127.0.0.1:8317", hasKey);
  const saved = values.get(CLI_PROXY_SETTINGS_KEY);
  const remove = () => hostProps(container).find(props => props.onClick && props.children === "Remove this proxy")!;
  invoke.mockRejectedValueOnce(new Error("credential store locked"));
  await act(async () => remove().onClick!());
  expect(values.get(CLI_PROXY_SETTINGS_KEY)).toBe(saved);
  expect(remove().disabled).toBe(false);
  expect(hostProps(container).some(props => props.children === "Error: credential store locked")).toBe(true);
  invoke.mockResolvedValueOnce(false);
  await act(async () => remove().onClick!());
  expect(values.has(CLI_PROXY_SETTINGS_KEY)).toBe(false);
  expect(inputs()).toHaveLength(0);
});
