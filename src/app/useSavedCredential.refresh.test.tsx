import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { useSavedCredential, type CredentialStoreStatus } from "./useSavedCredential";

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
