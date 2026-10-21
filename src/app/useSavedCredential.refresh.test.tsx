import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { useSavedCredential, type CredentialKind, type CredentialStoreStatus } from "./useSavedCredential";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("./nativeRuntime", () => ({ hasDesktopBackend: () => true }));
afterEach(() => { native.invoke.mockReset(); });

it("ignores an older locked status after a successful unlock refresh", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let api!: ReturnType<typeof useSavedCredential>;
  let finishOld!: (status: CredentialStoreStatus) => void;
  const pending = new Promise<CredentialStoreStatus>(resolve => { finishOld = resolve; });
  let reads = 0;
  native.invoke.mockImplementation(async (command: string) => {
    if (command === "credential_status") return ++reads === 1 ? pending : { ready: true, provider: "Encrypted vault", detail: null };
    if (command === "credential_exists") return true;
    return null;
  });
  function Probe() { api = useSavedCredential("test-device", "latticePairingCode"); return null; }
  try {
    await act(async () => root.render(<Probe />));
    await act(async () => api.refresh());
    expect(api.state.mode).toBe("saved");
    await act(async () => finishOld({ ready: false, provider: "Encrypted vault", detail: "locked" }));
    expect(api.state.mode).toBe("saved");
  } finally { await act(async () => root.unmount()); }
});

it("does not replace another device's credential state with an earlier refresh", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let api!: ReturnType<typeof useSavedCredential>;
  let finishOld!: (status: CredentialStoreStatus) => void;
  const pending = new Promise<CredentialStoreStatus>(resolve => { finishOld = resolve; });
  let reads = 0;
  native.invoke.mockImplementation(async (command: string, args: { profileId?: string }) => {
    if (command === "credential_status") return ++reads === 2 ? pending : { ready: true, provider: "Encrypted vault", detail: null };
    if (command === "credential_exists") return args.profileId === "device-a";
    return null;
  });
  function Probe({ id }: { id: string }) { api = useSavedCredential(id, "latticePairingCode"); return null; }
  try {
    await act(async () => root.render(<Probe id="device-a" />));
    let refresh!: Promise<void>;
    await act(async () => { refresh = api.refresh(); });
    await act(async () => root.render(<Probe id="device-b" />));
    expect(api.state.mode).toBe("missing");
    await act(async () => { finishOld({ ready: true, provider: "Encrypted vault", detail: null }); await refresh; });
    expect(api.state.mode).toBe("missing");
  } finally { await act(async () => root.unmount()); }
});

it.each([
  { nextId: "device-b", nextKind: "sshPassword" as CredentialKind },
  { nextId: "device-a", nextKind: "rdpPassword" as CredentialKind },
])("keeps $nextId/$nextKind saved when an earlier credential deletion finishes", async ({ nextId, nextKind }) => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let api!: ReturnType<typeof useSavedCredential>;
  let finishDelete!: () => void;
  const pendingDelete = new Promise<void>((resolve) => { finishDelete = resolve; });
  native.invoke.mockImplementation(async (command: string) => {
    if (command === "credential_status") return { ready: true, provider: "Encrypted vault", detail: null };
    if (command === "credential_exists") return true;
    if (command === "credential_delete") return pendingDelete;
    return null;
  });
  function Probe({ id, kind }: { id: string; kind: CredentialKind }) { api = useSavedCredential(id, kind); return null; }
  try {
    await act(async () => root.render(<Probe id="device-a" kind="sshPassword" />));
    let removal!: Promise<void>;
    await act(async () => { removal = api.remove(); });
    await act(async () => root.render(<Probe id={nextId} kind={nextKind} />));
    expect(api.state.mode).toBe("saved");
    await act(async () => { finishDelete(); await removal; });
    expect(native.invoke).toHaveBeenCalledWith("credential_delete", { profileId: "device-a", kind: "sshPassword" });
    expect(api.state.mode).toBe("saved");
  } finally { await act(async () => root.unmount()); }
});

it("does not cancel the new device's pending credential read when an old deletion finishes", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let api!: ReturnType<typeof useSavedCredential>;
  let finishDelete!: () => void;
  let finishRead!: (exists: boolean) => void;
  const pendingDelete = new Promise<void>((resolve) => { finishDelete = resolve; });
  const pendingRead = new Promise<boolean>((resolve) => { finishRead = resolve; });
  native.invoke.mockImplementation(async (command: string, args: { profileId?: string }) => {
    if (command === "credential_status") return { ready: true, provider: "Encrypted vault", detail: null };
    if (command === "credential_exists") return args.profileId === "device-b" ? pendingRead : true;
    if (command === "credential_delete") return pendingDelete;
    return null;
  });
  function Probe({ id }: { id: string }) { api = useSavedCredential(id, "sshPassword"); return null; }
  try {
    await act(async () => root.render(<Probe id="device-a" />));
    let removal!: Promise<void>;
    await act(async () => { removal = api.remove(); });
    await act(async () => root.render(<Probe id="device-b" />));
    expect(api.state.mode).toBe("loading");
    await act(async () => { finishDelete(); await removal; });
    await act(async () => finishRead(true));
    expect(api.state.mode).toBe("saved");
  } finally { await act(async () => root.unmount()); }
});

it("keeps a successful deletion authoritative over an overlapping refresh in the same scope", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let api!: ReturnType<typeof useSavedCredential>;
  let finishRead!: (exists: boolean) => void;
  const pendingRead = new Promise<boolean>((resolve) => { finishRead = resolve; });
  let reads = 0;
  native.invoke.mockImplementation(async (command: string) => {
    if (command === "credential_status") return { ready: true, provider: "Encrypted vault", detail: null };
    if (command === "credential_exists") return ++reads === 2 ? pendingRead : true;
    return null;
  });
  function Probe() { api = useSavedCredential("device-a", "sshPassword"); return null; }
  try {
    await act(async () => root.render(<Probe />));
    let refresh!: Promise<void>;
    await act(async () => { refresh = api.refresh(); });
    await act(async () => api.remove());
    expect(api.state.mode).toBe("missing");
    await act(async () => { finishRead(true); await refresh; });
    expect(api.state.mode).toBe("missing");
  } finally { await act(async () => root.unmount()); }
});

it("keeps a failed deletion saved and allows retrying it", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let api!: ReturnType<typeof useSavedCredential>;
  let failDelete = true;
  native.invoke.mockImplementation(async (command: string) => {
    if (command === "credential_status") return { ready: true, provider: "Encrypted vault", detail: null };
    if (command === "credential_exists") return true;
    if (command === "credential_delete" && failDelete) throw new Error("delete failed");
    return null;
  });
  function Probe() { api = useSavedCredential("device-a", "sshPassword"); return null; }
  try {
    await act(async () => root.render(<Probe />));
    await act(async () => { await expect(api.remove()).rejects.toThrow("delete failed"); });
    expect(api.state.mode).toBe("saved");
    failDelete = false;
    await act(async () => api.remove());
    expect(api.state.mode).toBe("missing");
  } finally { await act(async () => root.unmount()); }
});
