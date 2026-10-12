import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { createConnectionProfile, emptyDraft } from "../domain/connection";
import { useConnectionCredentialDraft } from "./useConnectionCredentialDraft";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("./nativeRuntime", () => ({ hasDesktopBackend: () => true }));
afterEach(() => native.invoke.mockReset());

const profile = createConnectionProfile({ ...emptyDraft(), name: "Offline login", hostname: "offline.example", username: "tester" }, "offline-profile");

async function probe(existing = true) {
  const root = createRoot(installFakeDom() as unknown as Element);
  let api!: ReturnType<typeof useConnectionCredentialDraft>;
  function Probe() { api = useConnectionCredentialDraft(existing ? profile : null); return null; }
  await act(async () => root.render(<Probe />));
  return { api: () => api, dispose: async () => { await act(async () => root.unmount()); } };
}

it("does not read passwords when opening an existing record", async () => {
  native.invoke.mockResolvedValue({ saved: true, allowMcpRead: false });
  const view = await probe();
  try {
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("connection_credential_status", { profileId: profile.id });
    expect(view.api().secret).toBe("");
    expect(view.api().credential).toBeUndefined();
    expect(view.api().saved).toBe(true);
  } finally { await view.dispose(); }
});

it("keeps secrets separate from the ordinary connection profile", async () => {
  const view = await probe(false);
  try {
    await act(async () => { view.api().setSecret("test-only-password"); view.api().setAllowMcpRead(true); });
    expect(view.api().credential).toEqual({ secret: "test-only-password", allowMcpRead: true });
    expect(profile).not.toHaveProperty("secret");
    expect(native.invoke).not.toHaveBeenCalled();
  } finally { await view.dispose(); }
});

it("revokes an existing grant without resending its password", async () => {
  native.invoke.mockResolvedValue({ saved: true, allowMcpRead: true });
  const view = await probe();
  try {
    await act(async () => view.api().setAllowMcpRead(false));
    expect(view.api().credential).toEqual({ secret: null, allowMcpRead: false });
  } finally { await view.dispose(); }
});

it("can revoke access when the credential store is locked", async () => {
  native.invoke.mockResolvedValue({ saved: false, allowMcpRead: true, detail: "vault locked" });
  const view = await probe();
  try {
    expect(view.api().error).toBe("vault locked");
    await act(async () => view.api().setAllowMcpRead(false));
    expect(view.api().credential).toEqual({ secret: null, allowMcpRead: false });
  } finally { await view.dispose(); }
});

it("reveals a password only on request and does not mark it as a replacement", async () => {
  native.invoke.mockImplementation(async command => command === "connection_credential_status" ? { saved: true, allowMcpRead: false } : "test-only-password");
  const view = await probe();
  try {
    await act(async () => view.api().reveal());
    expect(native.invoke).toHaveBeenLastCalledWith("connection_credential_read", { profileId: profile.id });
    expect(view.api().secret).toBe("test-only-password");
    expect(view.api().credential).toBeUndefined();
  } finally { await view.dispose(); }
});

it("can reveal the saved password again after clearing an unsaved replacement", async () => {
  native.invoke.mockImplementation(async command => command === "connection_credential_status" ? { saved: true, allowMcpRead: false } : "test-only-password");
  const view = await probe();
  try {
    await act(async () => view.api().setSecret("unsaved-test-password"));
    await act(async () => view.api().setSecret(""));
    await act(async () => view.api().reveal());
    expect(view.api().secret).toBe("test-only-password");
    expect(view.api().credential).toBeUndefined();
  } finally { await view.dispose(); }
});

it("does not replace a newly typed password with an older reveal response", async () => {
  let finish!: (value: string) => void;
  native.invoke.mockImplementation(async command => command === "connection_credential_status" ? { saved: true, allowMcpRead: false } : new Promise<string>(resolve => { finish = resolve; }));
  const view = await probe();
  try {
    let reveal!: Promise<void>;
    await act(async () => { reveal = view.api().reveal(); });
    await act(async () => view.api().setSecret("new-test-password"));
    await act(async () => { finish("old-test-password"); await reveal; });
    expect(view.api().secret).toBe("new-test-password");
  } finally { await view.dispose(); }
});

it("does not restore an old grant after the user has revoked it during loading", async () => {
  let finish!: (status: { saved: boolean; allowMcpRead: boolean }) => void;
  native.invoke.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const view = await probe();
  try {
    await act(async () => view.api().setAllowMcpRead(false));
    await act(async () => finish({ saved: true, allowMcpRead: true }));
    expect(view.api().allowMcpRead).toBe(false);
    expect(view.api().credential).toEqual({ secret: null, allowMcpRead: false });
  } finally { await view.dispose(); }
});
