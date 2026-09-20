import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RemoteHostApi } from "../../app/useRemoteHost";
import type { SavedCredentialState } from "../../app/useSavedCredential";
import { I18nProvider } from "../../i18n";
import { RemoteHostDialog } from "./RemoteHostDialog";

const credential = vi.hoisted(() => ({
  state: {
    mode: "missing",
    provider: "Secret Service",
    detail: null,
  } as SavedCredentialState,
}));

vi.mock("../../app/useSavedCredential", () => ({
  REMOTE_HOST_CREDENTIAL_ID: "remote-host",
  useSavedCredential: () => ({
    state: credential.state,
    refresh: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  credential.state = { mode: "missing", provider: "Secret Service", detail: null };
});

describe("remote host dialog", () => {
  function render(
    savedRelayAddress: string | null,
    status: RemoteHostApi["status"] = null,
    platform?: string,
    useSavedPairingCode = false,
    closedReason: string | null = null,
  ) {
    const storage: Storage = {
      length: 0,
      clear: vi.fn(),
      getItem: vi.fn(() => savedRelayAddress),
      key: vi.fn(() => null),
      removeItem: vi.fn(),
      setItem: vi.fn(),
    };
    vi.stubGlobal("window", { localStorage: storage });

    const host: RemoteHostApi = {
      deviceId: "123456789",
      deviceIdError: null,
      ensureDeviceId: vi.fn(async () => {}),
      configuration: useSavedPairingCode ? {
        bindAddress: "",
        port: 44900,
        fps: 5,
        allowInput: false,
        allowFiles: false,
        allowCommands: false,
        allowChat: false,
        allowCli: false,
        fileRoot: "",
        mode: "relay",
        relayAddress: "wss://relay.example/ws",
        pairingCode: "",
        useSavedPairingCode: true,
        rememberPairingCode: false,
      } : undefined,
      status,
      closedReason,
      start: vi.fn(),
      removeSavedPairingCode: vi.fn(async () => {}),
      retrySavedPairingCodeCleanup: vi.fn(async () => {}),
      stop: vi.fn(),
      clearClosedReason: vi.fn(),
    };
    const markup = renderToStaticMarkup(
      <I18nProvider locale="zh-TW">
        <RemoteHostDialog
          host={host}
          platform={platform}
          sensitiveClipboardClear="off"
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );
    return { host, markup };
  }

  it("shows the permanent device ID before relay sharing starts", () => {
    // A saved relay address opens the dialog in relay mode.
    const { markup } = render("wss://relay.example/ws");

    expect(markup).toContain("這台裝置的永久 ID");
    expect(markup).toContain("123 456 789");
    expect(markup).toContain("重新啟動 LatticeTerm 或電腦後仍會保持相同");
    expect(markup).toContain('aria-label="複製裝置 ID"');
  });

  it("explains a relay DNS failure and exposes the saved address", () => {
    const { markup } = render(
      "wss://relay.example/ws",
      null,
      undefined,
      false,
      "relay: I/O error: 無法識別遠台主機。(os error 11001)",
    );
    expect(markup).toContain("找不到中繼伺服器");
    expect(markup).toContain('id="remote-host-relay"');
    expect(markup).toContain('value="wss://relay.example/ws"');
    expect(markup).not.toContain("os error 11001");
  });

  it("preserves other relay errors and keeps the saved address collapsed", () => {
    const { markup } = render(
      "wss://relay.example/ws", null, undefined, false,
      "relay: I/O error: Connection refused (os error 10061)",
    );
    expect(markup).toContain("Connection refused");
    expect(markup).not.toContain('id="remote-host-relay"');
  });

  it("offers independent commands only on Windows and starts a new share fully open", () => {
    const windows = render(null, null, "windows").markup;
    expect(windows).toContain("允許 cmd／PowerShell 指令");
    expect(windows).toContain("不受分享資料夾範圍限制");
    const checkboxes = windows.match(/<input[^>]+type="checkbox"[^>]*>/g) ?? [];
    expect(windows).toContain("分享 Agent Fleet 工作區");
    expect(windows).toContain("分享 CLI 並允許操作");
    // A share nobody configured opens everything; "only look" turns it back.
    expect(checkboxes.every(input => input.includes("checked"))).toBe(true);
    expect(windows).toMatch(/<input type="radio" name="remote-host-level" checked=""\/>完全開放/);
    expect(render(null, null, "linux").markup).not.toContain("允許 cmd／PowerShell 指令");
  });

  it("hides the relay identity while direct sharing is selected", () => {
    // The nine-digit ID only means anything to a relay, and reading it creates
    // an identity file holding a registration token and a Noise private key.
    const { markup } = render(null);

    expect(markup).not.toContain("這台裝置的永久 ID");
    expect(markup).not.toContain("123 456 789");
    expect(markup).toContain("區網直連");
  });

  it("offers secure unattended-password persistence and explains the attempt limit", () => {
    const { markup } = render("wss://relay.example/ws");
    expect(markup).toContain("無人值守配對密碼（選填）");
    expect(markup).toContain("6～64 個字元");
    expect(markup).toContain("大小寫英文、數字與半形特殊符號");
    expect(markup).toContain("重啟仍有效");
    expect(markup).toContain("啟動成功後保存到 Secret Service");
    expect(markup).toMatch(/type="password"[^>]*maxLength="64"/i);
    expect(markup).not.toContain("自行編造簡單碼");
  });

  it("uses a saved unattended password without exposing a password field", () => {
    credential.state = { mode: "saved", provider: "Secret Service", detail: null };
    const { markup } = render("wss://relay.example/ws", null, undefined, true);

    expect(markup).toContain("已安全保存無人值守密碼");
    expect(markup).toContain("使用安全儲存區中已保存的主機密碼");
    expect(markup).toContain("刪除已保存密碼");
    expect(markup).not.toContain('id="remote-host-fixed-code"');
  });

  it("shows an actionable warning while secure cleanup is pending", () => {
    credential.state = {
      mode: "missing",
      provider: "Encrypted vault",
      detail: null,
      cleanupPending: true,
    };
    const { markup } = render("wss://relay.example/ws");

    expect(markup).toContain("仍需完成安全清理");
    expect(markup).toContain("這不會改變目前選用密碼是否已保存");
    expect(markup).toContain("請先解鎖或恢復該儲存區，再重試清理");
    expect(markup).toMatch(
      /<button[^>]*type="button"[^>]*>[\s\S]*?重試安全清理[\s\S]*?<\/button>/,
    );
  });

  it("associates the footer submit with the settings form", () => {
    const { markup } = render(null);
    const formId = markup.match(/<form id="([^"]+)"/)?.[1];
    expect(formId).toBeTruthy();
    const footer = markup.slice(markup.indexOf("<footer"));

    // Moving actions out of the scrolling form must retain native validation
    // and submission, rather than turning Start into an unrelated button.
    expect(markup.indexOf("</form>")).toBeLessThan(markup.indexOf("<footer"));
    expect(footer).toContain(`type="submit" form="${formId}"`);
    expect(footer).toContain("儲存設定");
    expect(footer).not.toContain("開始分享");
    expect(footer).toContain("關閉");
  });

  it("offers configuration without an on/off button while standing by", () => {
    const { markup } = render(null, {
      hostId: "test-host",
      address: "127.0.0.1:44900",
      pairingCode: "",
      expiresAt: 0,
      viewOnly: true,
      fileTransfer: false,
      state: "waiting",
      attemptsRemaining: 5,
      persistent: true,
      savedPairingCode: false,
    });
    const footer = markup.slice(markup.indexOf("<footer"));

    expect(footer).not.toContain("停止分享");
    expect(footer).toContain("連線與權限設定");
    expect(markup).toContain("開啟 LatticeTerm 即自動待命");
    expect(footer).not.toContain('type="submit"');
    expect(markup).not.toContain("<form");
  });

  it("shows the number of concurrent relay viewers", () => {
    const { markup } = render("wss://relay.example/ws", {
      hostId: "shared-host",
      address: "wss://relay.example/ws",
      pairingCode: "",
      expiresAt: 0,
      viewOnly: true,
      fileTransfer: false,
      state: "streaming",
      peer: "relay",
      activeSessions: 2,
      attemptsRemaining: 5,
      persistent: true,
      savedPairingCode: false,
    });

    expect(markup).toContain("已有 2 位使用者連線");
  });

  it("marks an active saved password without returning its plaintext", () => {
    const { markup } = render("wss://relay.example/ws", {
      hostId: "saved-host",
      address: "wss://relay.example/ws",
      pairingCode: "",
      expiresAt: 0,
      viewOnly: true,
      fileTransfer: false,
      state: "waiting",
      attemptsRemaining: 5,
      persistent: true,
      savedPairingCode: true,
    });
    expect(markup).toContain("無人值守密碼已安全保存");
    expect(markup).toContain("密碼已保存");
    expect(markup).not.toContain("複製配對碼");
  });

  it("marks a forgotten active password as current-session only", () => {
    credential.state = { mode: "missing", provider: "Secret Service", detail: null };
    const { markup } = render("wss://relay.example/ws", {
      hostId: "forgotten-host",
      address: "wss://relay.example/ws",
      pairingCode: "",
      expiresAt: 0,
      viewOnly: true,
      fileTransfer: false,
      state: "waiting",
      attemptsRemaining: 5,
      persistent: true,
      savedPairingCode: false,
    });

    expect(markup).toContain("目前密碼只在本次分享期間有效");
    expect(markup).not.toContain("無人值守密碼已安全保存");
    expect(markup).not.toContain("密碼已保存");
  });
});
