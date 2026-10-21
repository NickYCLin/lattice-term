import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SshApi } from "../../app/useSshSessions";
import type { SftpApi } from "../../app/useSftpSessions";
import type { RdpApi } from "../../app/useRdpSessions";
import type { RemoteApi } from "../../app/useRemoteSessions";
import { RemoteConnectFlow } from "../remote/RemoteConnectFlow";
import type { VncApi } from "../../app/useVncSessions";
import type { ConnectionProfile } from "../../domain/connection";
import { I18nProvider } from "../../i18n";
import { allNodes, installHostDom, props } from "../agents/testFixtures/interactionDom";
import { RdpConnectFlow } from "../rdp/RdpConnectFlow";
import { VncConnectFlow } from "../vnc/VncConnectFlow";
import { SftpConnectFlow } from "../sftp/SftpConnectFlow";
import { ConnectFlow } from "./ConnectFlow";

const { remove } = vi.hoisted(() => ({ remove: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../../app/authPreferences", () => ({
  loadAuthPref: () => ({ method: "password", keyPath: "" }), saveAuthPref: vi.fn(),
}));
vi.mock("../../app/useSavedCredential", () => ({
  useSavedCredential: () => ({ state: { mode: "saved", provider: "fixture", detail: null }, remove }),
}));
vi.mock("../overlays/modalFocus", () => ({ useModalFocus: () => {} }));
vi.mock("../overlays/HostFingerprintDialog", () => ({
  HostFingerprintDialog: ({ onTrustAndSave }: { onTrustAndSave: () => void }) =>
    <button onClick={onTrustAndSave}>trust</button>,
}));

function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => { resolve = done; });
  return { promise, resolve };
}
const profile: ConnectionProfile = {
  id: "connect-fixture", name: "測試連線", protocol: "ssh", hostname: "host.example.test",
  username: "tester", port: 22, environment: "unassigned", group: "", tags: [], favorite: false,
};
afterEach(() => { vi.unstubAllGlobals(); remove.mockReset(); });

describe.each(["ssh", "sftp", "rdp", "vnc", "remote"] as const)("%s operation exclusion", (protocol) => {
  async function setup() {
    const container = installHostDom();
    const root = createRoot(container as unknown as HTMLElement);
    const connect = vi.fn().mockResolvedValue({ outcome: "failed", stage: "connect", detail: "fixture failure" });
    const trustHost = vi.fn();
    const onConnected = vi.fn();
    const api = { connect, trustHost, defaultKeys: vi.fn(async () => []) };
    const common = { profile: protocol === "remote" ? { ...profile, protocol: "lattice" as const, deviceId: "123456789", relayAddress: "wss://relay.example.test" } : profile, onConnected, onCancel: vi.fn() };
    await act(async () => root.render(<I18nProvider locale="zh-TW">
      {protocol === "ssh" ? <ConnectFlow {...common} ssh={api as unknown as SshApi} />
        : protocol === "sftp" ? <SftpConnectFlow {...common} sftp={api as unknown as SftpApi} />
        : protocol === "rdp" ? <RdpConnectFlow {...common} rdp={api as unknown as RdpApi} />
        : protocol === "remote" ? <RemoteConnectFlow {...common} remote={api as unknown as RemoteApi} />
        : <VncConnectFlow {...common} vnc={api as unknown as VncApi} />}
    </I18nProvider>));
    connect.mockClear();
    const form = () => allNodes(container).find(node => node.tagName === "FORM")!;
    const submit = () => props(form()).onSubmit({ preventDefault() {} });
    const success = protocol === "sftp"
      ? { outcome: "connected", session: { sessionId: "fixture-session" } }
      : { outcome: "connected", sessionId: "fixture-session" };
    return { container, root, connect, trustHost, onConnected, submit, success };
  }

  it("submits only one connection before React renders the busy state", async () => {
    const context = await setup();
    const pending = deferred();
    context.connect.mockReturnValue(pending.promise);
    try {
      await act(async () => { context.submit(); context.submit(); });
      expect(context.connect).toHaveBeenCalledTimes(1);
      const removeButton = allNodes(context.container).find(node =>
        node.tagName === "BUTTON" && node.textContent.includes("刪除"))!;
      await act(async () => { props(removeButton).onClick(); });
      expect(remove).not.toHaveBeenCalled();
      await act(async () => { pending.resolve(context.success); });
      expect(context.onConnected).toHaveBeenCalledExactlyOnceWith("fixture-session");
    } finally { await act(async () => context.root.unmount()); }
  });

  it("does not connect or delete twice while credential removal is pending", async () => {
    const context = await setup();
    const pending = deferred();
    remove.mockReturnValue(pending.promise);
    context.connect.mockResolvedValue(context.success);
    try {
      const button = allNodes(context.container).find(node =>
        node.tagName === "BUTTON" && node.textContent.includes("刪除"))!;
      expect(button).toBeDefined();
      await act(async () => { props(button).onClick(); props(button).onClick(); context.submit(); });
      expect(remove).toHaveBeenCalledTimes(1);
      expect(context.connect).not.toHaveBeenCalled();
      const submitButton = allNodes(context.container).find(node =>
        node.tagName === "BUTTON" && props(node).type === "submit")!;
      expect(props(submitButton).disabled).toBe(true);
      await act(async () => { pending.resolve(undefined); });
      if (protocol === "remote") {
        const input = allNodes(context.container).find(node => node.attributes.id === "remote-pairing-code")!;
        await act(async () => { props(input).onChange({ currentTarget: { value: "fixture-password" } }); });
      }
      await act(async () => { context.submit(); });
      expect(context.connect).toHaveBeenCalledTimes(1);
    } finally { await act(async () => context.root.unmount()); }
  });

  it("releases the operation after a rejected connection and allows retry", async () => {
    const context = await setup();
    context.connect.mockRejectedValueOnce(new Error("fixture transport unavailable"))
      .mockResolvedValueOnce(context.success);
    try {
      await act(async () => { context.submit(); });
      expect(context.container.textContent).toContain("fixture transport unavailable");
      const button = allNodes(context.container).find(node =>
        node.tagName === "BUTTON" && props(node).type === "submit")!;
      expect(Boolean(props(button).disabled)).toBe(false);
      await act(async () => { context.submit(); });
      expect(context.connect).toHaveBeenCalledTimes(2);
      expect(context.onConnected).toHaveBeenCalledExactlyOnceWith("fixture-session");
    } finally { await act(async () => context.root.unmount()); }
  });

  it("releases the operation after credential deletion fails", async () => {
    const context = await setup();
    remove.mockRejectedValueOnce(new Error("fixture credential unavailable"));
    context.connect.mockResolvedValue(context.success);
    try {
      const button = allNodes(context.container).find(node =>
        node.tagName === "BUTTON" && node.textContent.includes("刪除"))!;
      await act(async () => { await props(button).onClick(); });
      expect(context.container.textContent).toContain("fixture credential unavailable");
      await act(async () => { context.submit(); });
      expect(context.connect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(
        protocol === "remote" ? { useSavedPairingCode: true } : { useSavedPassword: true },
      ));
    } finally { await act(async () => context.root.unmount()); }
  });

  if (protocol === "ssh" || protocol === "sftp") {
    it("persists host trust and reconnects only once on a double click", async () => {
      const context = await setup();
      const pending = deferred();
      context.connect.mockResolvedValueOnce({ outcome: "hostUnknown", host: profile.hostname,
        port: 22, algorithm: "ssh-ed25519", fingerprint: "SHA256:fixture" })
        .mockResolvedValue(context.success);
      context.trustHost.mockReturnValue(pending.promise);
      try {
        await act(async () => { context.submit(); });
        const button = allNodes(context.container).find(node => node.textContent === "trust" && node.tagName === "BUTTON")!;
        await act(async () => { void props(button).onClick(); void props(button).onClick(); });
        expect(context.trustHost).toHaveBeenCalledTimes(1);
        await act(async () => { pending.resolve(undefined); });
        expect(context.connect).toHaveBeenCalledTimes(2);
        expect(context.onConnected).toHaveBeenCalledExactlyOnceWith("fixture-session");
      } finally { await act(async () => context.root.unmount()); }
    });
  }
});
