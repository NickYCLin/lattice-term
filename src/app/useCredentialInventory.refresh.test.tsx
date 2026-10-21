import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createConnectionProfile, emptyDraft } from "../domain/connection";
import { installFakeDom } from "./testFixtures/hookDom";
import { useCredentialInventory, type CredentialStoreStatus } from "./useSavedCredential";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("./nativeRuntime", () => ({ hasDesktopBackend: () => true }));
beforeEach(() => {
  installFakeDom();
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke: native.invoke });
});
afterEach(() => { native.invoke.mockReset(); vi.unstubAllGlobals(); });

const ready: CredentialStoreStatus = { ready: true, provider: "Encrypted vault", detail: null };
const profiles = ["profile-a", "profile-b"].map((id) => createConnectionProfile({
  ...emptyDraft(), name: id, hostname: "fixture.invalid", username: "tester",
}, id));

it.each([1, 2])("ignores outdated inventory status from read %i after a newer refresh", async (pendingRead) => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let api!: ReturnType<typeof useCredentialInventory>;
  let finishOld!: (status: CredentialStoreStatus) => void;
  const pending = new Promise<CredentialStoreStatus>((resolve) => { finishOld = resolve; });
  let reads = 0;
  native.invoke.mockImplementation(async (command: string) => {
    if (command === "credential_status") return ++reads === pendingRead ? pending : ready;
    if (command === "credential_exists") return true;
    return null;
  });
  function Probe() { api = useCredentialInventory(profiles); return null; }
  try {
    await act(async () => root.render(<Probe />));
    let oldRefresh: Promise<void> | undefined;
    if (pendingRead === 2) await act(async () => { oldRefresh = api.refresh(); });
    await act(async () => api.refresh());
    expect(api.state).toMatchObject({ mode: "ready", detail: null });
    expect(api.state.entries).toHaveLength(2);
    await act(async () => {
      finishOld({ ready: false, provider: "Encrypted vault", detail: "locked" });
      await oldRefresh;
    });
    expect(api.state.mode).toBe("ready");
    expect(api.state.entries).toHaveLength(2);
  } finally { await act(async () => root.unmount()); }
});

it("does not restore a previous profile list when an old refresh finishes", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let api!: ReturnType<typeof useCredentialInventory>;
  let finishOld!: (status: CredentialStoreStatus) => void;
  const pending = new Promise<CredentialStoreStatus>((resolve) => { finishOld = resolve; });
  let reads = 0;
  native.invoke.mockImplementation(async (command: string) => {
    if (command === "credential_status") return ++reads === 2 ? pending : ready;
    if (command === "credential_exists") return true;
    return null;
  });
  const firstProfiles = [profiles[0]];
  const nextProfiles = [profiles[1]];
  function Probe({ items }: { items: typeof profiles }) { api = useCredentialInventory(items); return null; }
  try {
    await act(async () => root.render(<Probe items={firstProfiles} />));
    let oldRefresh!: Promise<void>;
    await act(async () => { oldRefresh = api.refresh(); });
    await act(async () => root.render(<Probe items={nextProfiles} />));
    expect(api.state.entries.map((entry) => entry.profileId)).toEqual(["profile-b"]);
    await act(async () => { finishOld(ready); await oldRefresh; });
    expect(api.state.entries.map((entry) => entry.profileId)).toEqual(["profile-b"]);
  } finally { await act(async () => root.unmount()); }
});

it("does not resurrect a deleted credential from an in-flight inventory read", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let api!: ReturnType<typeof useCredentialInventory>;
  let finishOld!: (exists: boolean) => void;
  const pending = new Promise<boolean>((resolve) => { finishOld = resolve; });
  let holdRead = false;
  let deleted = false;
  native.invoke.mockImplementation(async (command: string, args: { profileId?: string }) => {
    if (command === "credential_status") return ready;
    if (command === "credential_delete") { deleted = true; return null; }
    if (command === "credential_exists") {
      if (args.profileId === "profile-a") return holdRead && !deleted ? pending : !deleted;
      return true;
    }
    return null;
  });
  function Probe() { api = useCredentialInventory(profiles); return null; }
  try {
    await act(async () => root.render(<Probe />));
    holdRead = true;
    let oldRefresh!: Promise<void>;
    await act(async () => { oldRefresh = api.refresh(); });
    await act(async () => api.remove({ profileId: "profile-a", kind: "sshPassword" }));
    expect(api.state.entries.map((entry) => entry.profileId)).toEqual(["profile-b"]);
    await act(async () => { finishOld(true); await oldRefresh; });
    expect(api.state.mode).toBe("ready");
    expect(api.state.entries.map((entry) => entry.profileId)).toEqual(["profile-b"]);
  } finally { await act(async () => root.unmount()); }
});

it("refreshes the current profile scope when an earlier deletion finishes", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let api!: ReturnType<typeof useCredentialInventory>;
  let finishDelete!: () => void;
  const pendingDelete = new Promise<void>((resolve) => { finishDelete = resolve; });
  let deleted = false;
  native.invoke.mockImplementation(async (command: string, args: { profileId?: string }) => {
    if (command === "credential_status") return ready;
    if (command === "credential_delete") { await pendingDelete; deleted = true; return null; }
    if (command === "credential_exists") return args.profileId !== "profile-a" || !deleted;
    return null;
  });
  const firstProfiles = [profiles[0]];
  function Probe({ items }: { items: typeof profiles }) { api = useCredentialInventory(items); return null; }
  try {
    await act(async () => root.render(<Probe items={firstProfiles} />));
    let removal!: Promise<void>;
    await act(async () => { removal = api.remove({ profileId: "profile-a", kind: "sshPassword" }); });
    await act(async () => root.render(<Probe items={profiles} />));
    await act(async () => { finishDelete(); await removal; });
    expect(api.state.mode).toBe("ready");
    expect(api.state.entries.map((entry) => entry.profileId)).toEqual(["profile-b"]);
  } finally { await act(async () => root.unmount()); }
});

it("keeps the inventory intact when credential deletion fails", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let api!: ReturnType<typeof useCredentialInventory>;
  native.invoke.mockImplementation(async (command: string) => {
    if (command === "credential_status") return ready;
    if (command === "credential_exists") return true;
    if (command === "credential_delete") throw new Error("delete failed");
    return null;
  });
  function Probe() { api = useCredentialInventory(profiles); return null; }
  try {
    await act(async () => root.render(<Probe />));
    await act(async () => {
      await expect(api.remove({ profileId: "profile-a", kind: "sshPassword" })).rejects.toThrow("delete failed");
    });
    expect(api.state.mode).toBe("ready");
    expect(api.state.entries).toHaveLength(2);
  } finally { await act(async () => root.unmount()); }
});

it("shows an unavailable inventory if the vault locks after deletion", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let api!: ReturnType<typeof useCredentialInventory>;
  let deleted = false;
  native.invoke.mockImplementation(async (command: string) => {
    if (command === "credential_status") return deleted ? { ...ready, ready: false, detail: "locked" } : ready;
    if (command === "credential_exists") return true;
    if (command === "credential_delete") { deleted = true; return null; }
    return null;
  });
  function Probe() { api = useCredentialInventory(profiles); return null; }
  try {
    await act(async () => root.render(<Probe />));
    await act(async () => api.remove({ profileId: "profile-a", kind: "sshPassword" }));
    expect(api.state).toMatchObject({ mode: "unavailable", detail: "locked", entries: [] });
  } finally { await act(async () => root.unmount()); }
});

it("does not start another inventory read after unmounting during deletion", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let api!: ReturnType<typeof useCredentialInventory>;
  let finishDelete!: () => void;
  const pendingDelete = new Promise<void>((resolve) => { finishDelete = resolve; });
  native.invoke.mockImplementation(async (command: string) => {
    if (command === "credential_status") return ready;
    if (command === "credential_exists") return true;
    if (command === "credential_delete") return pendingDelete;
    return null;
  });
  function Probe() { api = useCredentialInventory(profiles); return null; }
  await act(async () => root.render(<Probe />));
  let removal!: Promise<void>;
  try {
    await act(async () => { removal = api.remove({ profileId: "profile-a", kind: "sshPassword" }); });
  } finally { await act(async () => root.unmount()); }
  native.invoke.mockClear();
  await act(async () => { finishDelete(); await removal; });
  expect(native.invoke).not.toHaveBeenCalled();
});
