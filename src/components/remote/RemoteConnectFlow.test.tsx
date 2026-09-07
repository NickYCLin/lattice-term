import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RemoteApi } from "../../app/useRemoteSessions";
import type { SavedCredentialState } from "../../app/useSavedCredential";
import type { ConnectionProfile } from "../../domain/connection";
import { I18nProvider } from "../../i18n";
import { RemoteConnectFlow } from "./RemoteConnectFlow";

const credential = vi.hoisted(() => ({
  state: {
    mode: "missing",
    provider: "Windows Credential Manager",
    detail: null,
  } as SavedCredentialState,
}));

vi.mock("../../app/useSavedCredential", () => ({
  useSavedCredential: () => ({
    state: credential.state,
    refresh: vi.fn(),
    remove: vi.fn(),
  }),
}));

function profile(relay: boolean): ConnectionProfile {
  return {
    id: relay ? "relay-profile" : "direct-profile",
    name: relay ? "Relay Agent" : "Direct Agent",
    protocol: "lattice",
    hostname: relay ? "" : "192.0.2.10",
    username: "",
    port: relay ? 0 : 44900,
    environment: "unassigned",
    group: "Remote",
    tags: [],
    favorite: false,
    deviceId: relay ? "123456789" : undefined,
    relayAddress: relay ? "wss://relay.example.test" : undefined,
  };
}

const remote = {
  connect: vi.fn(),
} as unknown as RemoteApi;

function render(relay: boolean) {
  return renderToStaticMarkup(
    <I18nProvider locale="zh-TW">
      <RemoteConnectFlow
        profile={profile(relay)}
        remote={remote}
        onConnected={vi.fn()}
        onCancel={vi.fn()}
      />
    </I18nProvider>,
  );
}

describe("RemoteConnectFlow", () => {
  it("keeps legacy pairing explicitly opt-in for old hosts", () => {
    const markup = render(true);
    expect(markup).toContain("舊版配對碼相容模式");
    expect(markup).toContain("區分大小寫");
    expect(markup).not.toContain("checked=\"\"");
  });
  it("offers secure storage only for a saved relay device", () => {
    credential.state = {
      mode: "missing",
      provider: "Windows Credential Manager",
      detail: null,
    };

    const relayMarkup = render(true);
    const directMarkup = render(false);

    expect(relayMarkup).toContain("成功配對後將配對碼保存到 Windows Credential Manager");
    expect(directMarkup).not.toContain("成功配對後將配對碼保存");
  });

  it("shows the saved pairing-code controls without exposing the code", () => {
    credential.state = {
      mode: "saved",
      provider: "Windows Credential Manager",
      detail: null,
    };

    const markup = render(true);

    expect(markup).toContain("配對碼已安全保存");
    expect(markup).toContain("使用 Windows Credential Manager 中已儲存的配對碼");
    expect(markup).toContain("刪除已儲存配對碼");
    expect(markup).not.toContain("12345678");
  });
});
