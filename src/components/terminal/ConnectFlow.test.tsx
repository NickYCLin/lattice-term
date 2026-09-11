import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SshApi } from "../../app/useSshSessions";
import type { ConnectionProfile } from "../../domain/connection";
import { I18nProvider } from "../../i18n";
import { choosePrivateKeyPath, ConnectFlow } from "./ConnectFlow";

const dialogOpen = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: dialogOpen }));
vi.mock("../../app/authPreferences", () => ({
  loadAuthPref: () => ({ method: "privateKey", keyPath: "" }),
  saveAuthPref: vi.fn(),
}));
vi.mock("../../app/useSavedCredential", () => ({
  useSavedCredential: () => ({
    state: { mode: "missing", provider: "System credential store", detail: null },
    remove: vi.fn(),
  }),
}));

const profile: ConnectionProfile = {
  id: "ssh-profile",
  name: "測試主機",
  protocol: "ssh",
  hostname: "host.example.test",
  username: "tester",
  port: 22,
  environment: "unassigned",
  group: "",
  tags: [],
  favorite: false,
};

const ssh = {
  defaultKeys: vi.fn(async () => []),
} as unknown as SshApi;

describe("ConnectFlow private key picker", () => {
  it("shows a native file picker beside the editable key path", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider locale="zh-TW">
        <ConnectFlow
          profile={profile}
          ssh={ssh}
          onConnected={vi.fn()}
          onCancel={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(markup).toContain('id="connect-key-path"');
    expect(markup).toContain('type="button"');
    expect(markup).toContain("選擇檔案");
  });

  it("accepts one file of any extension and returns its native path", async () => {
    dialogOpen.mockResolvedValueOnce("C:\\Users\\tester\\.ssh\\id_ed25519");

    await expect(choosePrivateKeyPath("選擇檔案")).resolves.toBe(
      "C:\\Users\\tester\\.ssh\\id_ed25519",
    );
    expect(dialogOpen).toHaveBeenCalledExactlyOnceWith({
      directory: false,
      multiple: false,
      title: "選擇檔案",
    });
  });

  it("leaves the existing path unchanged when the picker is cancelled", async () => {
    dialogOpen.mockResolvedValueOnce(null);
    await expect(choosePrivateKeyPath("Choose file")).resolves.toBeNull();
  });
});
