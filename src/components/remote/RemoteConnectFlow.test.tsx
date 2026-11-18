import { zhTW } from "../../i18n/messages/zh-TW";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { VaultApi } from "../../app/useVault";
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

function render(relay: boolean, platform?: string) {
  return renderToStaticMarkup(
    <I18nProvider locale="zh-TW">
      <RemoteConnectFlow
        platform={platform}
        profile={profile(relay)}
        remote={remote}
        onConnected={vi.fn()}
        onCancel={vi.fn()}
      />
    </I18nProvider>,
  );
}

describe("RemoteConnectFlow", () => {
  it("no longer offers the legacy pairing mode", () => {
    const markup = render(true);
    expect(markup).not.toContain("舊版配對碼相容模式");
    expect(markup).toContain("區分大小寫");
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

it.each(["ios", "android"])("removes pairing explanations on %s but keeps fields and saved-code actions", platform => {
  credential.state = { mode: "missing", provider: "Fixture store", detail: null };
  for (const relay of [true, false]) {
    const mobile = render(relay, platform), desktop = render(relay, "linux");
    for (const text of ["加密配對與安全儲存", "配對碼只用於 Noise", "區分大小寫"]) expect(mobile).not.toContain(text);
    expect(mobile).not.toContain('aria-describedby="remote-pairing-code-hint"');
    expect(desktop).toContain('id="remote-pairing-code-hint"');
    expect(mobile).toContain('id="remote-pairing-code"'); expect(mobile).toContain("連線"); expect(mobile).toContain("取消");
  }
  credential.state = { mode: "saved", provider: "Fixture store", detail: null };
  const saved = render(true, platform);
  expect(saved).toContain("配對碼已安全保存"); expect(saved).toContain("使用 Fixture store 中已儲存的配對碼"); expect(saved).toContain("刪除已儲存配對碼");
});

it("keeps the iPhone device-storage title and action, omitting only its long description", () => {
  credential.state = { mode: "missing", provider: "Fixture store", detail: null };
  const markup = renderToStaticMarkup(<I18nProvider locale="zh-TW"><RemoteConnectFlow profile={profile(true)} remote={remote} platform="ios" vault={{ backend: "vault", status: { state: "locked" }, busy: false, problem: null } as VaultApi} onConnected={vi.fn()} onCancel={vi.fn()} /></I18nProvider>);
  expect(markup).toContain("在這支 iPhone 記住配對碼"); expect(markup).toContain("使用 iOS 安全儲存區保存"); expect(markup).not.toContain(zhTW["remote.connect.deviceStorageBody"]);
});
