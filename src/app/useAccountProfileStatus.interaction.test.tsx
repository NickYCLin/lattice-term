import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import type { ChatAccountProfile } from "./chatAccountProfiles";
import type { AgentAccountInfo } from "./useAgentSessions";
import { useAccountProfileStatus } from "./useAccountProfileStatus";
import { CLI_PROXY_SETTINGS_CHANGED } from "./cliProxyApi";

const NativeEvent = Event;
let events: EventTarget;

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./nativeRuntime", () => ({ hasDesktopBackend: () => true }));
vi.mock("./useCliProxyApi", () => ({ useCliProxySettings: () => ({ proxies: [] }) }));

const profile: ChatAccountProfile = {
  id: "account", definitionId: "codex", name: "Account", configDirectory: "profiles/first",
};
const signedIn: AgentAccountInfo = { state: "signedIn", label: "current", method: "oauth" };
const signedOut: AgentAccountInfo = { state: "signedOut", label: null, method: null };
let root: ReturnType<typeof createRoot> | null = null;
let api: ReturnType<typeof useAccountProfileStatus>;

function Probe({ profiles }: { profiles: ChatAccountProfile[] }) {
  api = useAccountProfileStatus(profiles);
  return null;
}

async function render(profiles = [profile]) {
  if (!root) {
    root = createRoot(installFakeDom() as unknown as Element);
    events = new EventTarget();
    vi.stubGlobal("addEventListener", events.addEventListener.bind(events));
    vi.stubGlobal("removeEventListener", events.removeEventListener.bind(events));
  }
  Object.assign(globalThis, { __TAURI_INTERNALS__: { invoke } });
  await act(async () => root!.render(<Probe profiles={profiles} />));
  await act(async () => { await vi.dynamicImportSettled(); });
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it("refreshes signed-in account key matching when proxy credentials change", async () => {
  const before = { ...signedIn, cliProxy: { id: "proxy", sameKey: true } };
  const after = { ...signedIn, cliProxy: { id: "proxy", sameKey: false } };
  invoke.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
  await render();
  expect(api.statuses.account).toEqual(before);
  await act(async () => {
    events.dispatchEvent(new NativeEvent(CLI_PROXY_SETTINGS_CHANGED));
    await vi.dynamicImportSettled();
  });
  expect(api.statuses.account).toEqual(after);
});

it("does not let a pending refresh overwrite a credential-change refresh", async () => {
  let finishOld!: (value: AgentAccountInfo) => void;
  invoke.mockResolvedValueOnce(signedIn)
    .mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
    .mockResolvedValueOnce(signedOut);
  await render();
  let pending!: Promise<void>;
  await act(async () => { pending = api.refresh(); await vi.dynamicImportSettled(); });
  await act(async () => {
    events.dispatchEvent(new NativeEvent(CLI_PROXY_SETTINGS_CHANGED));
    await vi.dynamicImportSettled();
  });
  await act(async () => { finishOld(signedIn); await pending; });
  expect(api.statuses.account).toEqual(signedOut);
});

it("stops listening for credential changes after unmount", async () => {
  invoke.mockResolvedValue(signedIn);
  await render();
  await act(async () => root!.unmount());
  root = null;
  const calls = invoke.mock.calls.length;
  await act(async () => {
    events.dispatchEvent(new NativeEvent(CLI_PROXY_SETTINGS_CHANGED));
    await vi.dynamicImportSettled();
  });
  expect(invoke).toHaveBeenCalledTimes(calls);
});

it("keeps the newest refresh when an older request finishes later", async () => {
  let finishOld!: (value: AgentAccountInfo) => void;
  invoke.mockResolvedValueOnce(signedOut)
    .mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
    .mockResolvedValueOnce(signedIn);
  await render();
  let pending!: Promise<void>;
  await act(async () => { pending = api.refresh(); await vi.dynamicImportSettled(); });
  await act(async () => { await api.refresh(); });
  await act(async () => { finishOld(signedOut); await pending; });
  expect(api.statuses.account).toEqual(signedIn);
});

it("does not restore a removed profile from a pending refresh", async () => {
  let finishOld!: (value: AgentAccountInfo) => void;
  invoke.mockResolvedValueOnce(signedOut)
    .mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  await render();
  let pending!: Promise<void>;
  await act(async () => { pending = api.refresh(); await vi.dynamicImportSettled(); });
  await render([]);
  await act(async () => { finishOld(signedIn); await pending; });
  expect(api.statuses).toEqual({});
});

it("does not replace a new directory status with an old refresh", async () => {
  let finishOld!: (value: AgentAccountInfo) => void;
  invoke.mockResolvedValueOnce(signedOut)
    .mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
    .mockResolvedValueOnce(signedIn);
  await render();
  let pending!: Promise<void>;
  await act(async () => { pending = api.refresh(); await vi.dynamicImportSettled(); });
  await render([{ ...profile, configDirectory: "profiles/second" }]);
  await act(async () => { finishOld(signedOut); await pending; });
  expect(api.statuses.account).toEqual(signedIn);
});
