import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { CLI_PROXY_SETTINGS_KEY } from "../../app/cliProxyApi";
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

async function mount(baseUrl?: string, hasKey = false) {
  values = new Map(baseUrl ? [[CLI_PROXY_SETTINGS_KEY, JSON.stringify({
    proxies: [{ id: "default", label: "", baseUrl }],
  })]] : []);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  container = installFakeDom();
  document.createElementNS = ((_namespace: string | null, name: string) => document.createElement(name)) as typeof document.createElementNS;
  vi.stubGlobal("dispatchEvent", vi.fn());
  invoke.mockImplementation(async (command: string) => {
    if (command === "cliproxy_key_exists") return hasKey;
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
