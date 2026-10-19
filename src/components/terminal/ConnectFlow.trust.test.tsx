import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SshApi } from "../../app/useSshSessions";
import type { SftpApi } from "../../app/useSftpSessions";
import type { ConnectionProfile } from "../../domain/connection";
import { I18nProvider } from "../../i18n";
import { allNodes, installHostDom, props } from "../agents/testFixtures/interactionDom";
import { SftpConnectFlow } from "../sftp/SftpConnectFlow";
import { ConnectFlow } from "./ConnectFlow";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../../app/authPreferences", () => ({
  loadAuthPref: () => ({ method: "password", keyPath: "" }),
  saveAuthPref: vi.fn(),
}));
vi.mock("../../app/useSavedCredential", () => ({
  useSavedCredential: () => ({
    state: { mode: "missing", provider: "fixture", detail: null },
    remove: vi.fn(),
  }),
}));
vi.mock("../overlays/modalFocus", () => ({ useModalFocus: () => {} }));
vi.mock("../overlays/HostFingerprintDialog", () => ({
  HostFingerprintDialog: ({ onTrustAndSave }: { onTrustAndSave: () => void }) =>
    <button onClick={onTrustAndSave}>trust</button>,
}));
vi.mock("../overlays/HostKeyChangedDialog", () => ({
  HostKeyChangedDialog: ({ onAcceptRiskAndReplace }: { onAcceptRiskAndReplace: () => void }) =>
    <button onClick={onAcceptRiskAndReplace}>replace</button>,
}));

const profile: ConnectionProfile = {
  id: "trust-test", name: "測試主機", protocol: "ssh",
  hostname: "host.example.test", username: "tester", port: 22,
  environment: "unassigned", group: "", tags: [], favorite: false,
};

afterEach(() => vi.unstubAllGlobals());

describe.each(["ssh", "sftp"] as const)("%s host trust", (protocol) => {
  it.each(["hostUnknown", "hostChanged"] as const)("reports %s persistence failures without reconnecting", async (outcome) => {
    const container = installHostDom();
    const root = createRoot(container as unknown as HTMLElement);
    const connect = vi.fn().mockResolvedValue({
      outcome, host: profile.hostname, port: profile.port,
      algorithm: "ssh-ed25519", fingerprint: "SHA256:new",
      receivedFingerprint: "SHA256:new",
      expected: { algorithm: "ssh-ed25519", fingerprint: "SHA256:old", firstTrustedAt: 0, lastSeenAt: 0 },
    });
    const trustHost = vi.fn().mockRejectedValueOnce(new Error("known_hosts write denied"))
      .mockResolvedValue(undefined);
    const onConnected = vi.fn();
    const api = { connect, trustHost, defaultKeys: vi.fn(async () => []) };
    const submit = async () => {
      const form = allNodes(container).find((node) => node.tagName === "FORM")!;
      await act(async () => { props(form).onSubmit({ preventDefault() {} }); });
    };
    const trust = async () => {
      const button = allNodes(container).find((node) =>
        node.tagName === "BUTTON" && ["trust", "replace"].includes(node.textContent))!;
      await act(async () => { await props(button).onClick(); });
    };
    try {
      await act(async () => {
        root.render(<I18nProvider locale="zh-TW">
          {protocol === "ssh"
            ? <ConnectFlow profile={profile} ssh={api as unknown as SshApi} onConnected={onConnected} onCancel={vi.fn()} />
            : <SftpConnectFlow profile={profile} sftp={api as unknown as SftpApi} onConnected={onConnected} onCancel={vi.fn()} />}
        </I18nProvider>);
      });
      await submit();
      await trust();
      expect(container.textContent).toContain("known_hosts write denied");
      expect(allNodes(container).some((node) => node.tagName === "FORM")).toBe(true);
      expect(connect).toHaveBeenCalledTimes(1);
      expect(onConnected).not.toHaveBeenCalled();
      expect(trustHost).toHaveBeenCalledWith(profile.hostname, 22, "ssh-ed25519", "SHA256:new");
      await submit();
      connect.mockResolvedValueOnce(protocol === "ssh"
        ? { outcome: "connected", sessionId: "retry-session" }
        : { outcome: "connected", session: { sessionId: "retry-session" } });
      await trust();
      expect(onConnected).toHaveBeenCalledExactlyOnceWith("retry-session");
    } finally {
      await act(async () => root.unmount());
    }
  });
});
