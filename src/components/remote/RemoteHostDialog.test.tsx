import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RemoteHostApi } from "../../app/useRemoteHost";
import { I18nProvider } from "../../i18n";
import { RemoteHostDialog } from "./RemoteHostDialog";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("remote host dialog", () => {
  function render(
    savedRelayAddress: string | null,
    status: RemoteHostApi["status"] = null,
    platform?: string,
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
      status,
      closedReason: null,
      start: vi.fn(),
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

  it("offers independent commands only on Windows and keeps all execution grants off", () => {
    const windows = render(null, null, "windows").markup;
    expect(windows).toContain("允許 cmd／PowerShell 指令");
    expect(windows).toContain("不受分享資料夾範圍限制");
    const checkboxes = windows.match(/<input[^>]+type="checkbox"[^>]*>/g) ?? [];
    expect(checkboxes).toHaveLength(3);
    expect(checkboxes.every(input => !input.includes("checked"))).toBe(true);
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

  it("explains fixed password characters, privacy and the durable attempt limit", () => {
    const { markup } = render("wss://relay.example/ws");
    expect(markup).toContain("固定配對密碼（選填）");
    expect(markup).toContain("6～64 個字元");
    expect(markup).toContain("大小寫英文、數字與半形特殊符號");
    expect(markup).toContain("重啟仍有效");
    expect(markup).toMatch(/type="password"[^>]*maxLength="64"/i);
    expect(markup).not.toContain("自行編造簡單碼");
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
    expect(footer).toContain("開始分享");
    expect(footer).toContain("取消");
  });

  it("keeps stop and keep-running actions in the active sharing footer", () => {
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
    });
    const footer = markup.slice(markup.indexOf("<footer"));

    expect(footer).toContain("停止分享");
    expect(footer).toContain("在背景繼續分享");
    expect(footer).not.toContain('type="submit"');
    expect(markup).not.toContain("<form");
  });
});
