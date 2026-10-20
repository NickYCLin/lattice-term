import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createConnectionProfile, emptyDraft } from "../../domain/connection";
import { I18nProvider } from "../../i18n";
import { ConnectionDrawer } from "./ConnectionDrawer";
import {
  radioNavigationIndex,
  radioNavigationTargetIndex,
} from "./radioNavigation";

function renderDrawer(
  profile: Parameters<typeof ConnectionDrawer>[0]["profile"] = null,
  options: {
    supportedProtocols?: readonly string[];
    mobile?: boolean;
  } = {},
) {
  return renderToStaticMarkup(
    <I18nProvider locale="zh-TW">
      <ConnectionDrawer
        profile={profile}
        profiles={profile ? [profile] : []}
        supportedProtocols={
          options.supportedProtocols ?? ["ssh", "sftp", "rdp", "vnc", "lattice"]
        }
        mobile={options.mobile ?? false}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />
    </I18nProvider>,
  );
}

describe("connection drawer", () => {
  it("pairs each address with its port and shares the hint outside both rows", () => {
    const markup = renderDrawer();
    const rows = markup.split('class="connection-addresses__row"');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain('data-field="hostname"');
    expect(rows[1]).toContain('data-field="port"');
    expect(rows[1]).not.toContain('data-field="username"');
    expect(rows[2]).toContain('data-field="additional-hostname"');
    expect(rows[2]).toContain('data-field="additional-port"');
    expect(markup.match(/connection-addresses__hint/g)).toHaveLength(1);
    expect(markup).toContain('aria-label="另一個位址的連接埠（選填）"');
    expect(markup).not.toContain("另一個主機位址（選填）");
  });

  it("offers a masked offline login record and makes only save submit the form", () => {
    const markup = renderDrawer();
    expect(markup).toContain('type="password"');
    expect(markup).toContain('autoComplete="new-password"');
    expect(markup).toContain("允許 MCP 讀取這筆帳密");
    expect(markup).toContain("內容可能留在模型的對話紀錄");
    expect(markup).toMatch(/type="submit"[^>]*form="[^"]+"[^>]*class="button button--secondary"/);
    expect(markup).toMatch(/type="button"[^>]*class="button button--primary"/);
  });

  it("keeps the primary add flow compact and actionable", () => {
    const markup = renderDrawer();

    expect(
      markup.match(/class="protocol-option(?: is-selected)?"/g),
    ).toHaveLength(5);
    expect(markup).toContain("連線資料");
    expect(markup).toContain("使用者名稱");
    expect(markup).toContain("進階整理");
    expect(markup).toContain("儲存並連線");
    expect(markup).not.toContain("登入資訊");
    expect(markup).not.toContain("檢查設定");
    expect(markup.match(/role="radio"[^>]*tabindex="0"/g)).toHaveLength(2);
    expect(markup.match(/role="radio"[^>]*tabindex="-1"/g)).toHaveLength(7);
  });

  it("uses the expected wrapping keyboard navigation for radio groups", () => {
    expect(radioNavigationIndex("ArrowRight", 4, 5)).toBe(0);
    expect(radioNavigationIndex("ArrowDown", 1, 5)).toBe(2);
    expect(radioNavigationIndex("ArrowLeft", 0, 5)).toBe(4);
    expect(radioNavigationIndex("ArrowUp", 3, 5)).toBe(2);
    expect(radioNavigationIndex("Home", 3, 5)).toBe(0);
    expect(radioNavigationIndex("End", 1, 5)).toBe(4);
    expect(radioNavigationIndex("Tab", 1, 5)).toBeNull();
    expect(radioNavigationIndex("ArrowRight", -1, 5)).toBeNull();
    expect(
      radioNavigationTargetIndex("ArrowRight", 0, [false, true, false]),
    ).toBe(2);
    expect(
      radioNavigationTargetIndex("ArrowLeft", 0, [false, true, false]),
    ).toBe(2);
    expect(
      radioNavigationTargetIndex("ArrowRight", 0, [true, true, true]),
    ).toBeNull();
  });

  it("does not show an irrelevant username for VNC", () => {
    const draft = {
      ...emptyDraft("vnc"),
      name: "Shared screen",
      hostname: "screen.example.com",
      username: "stale-user",
    };
    const markup = renderDrawer(createConnectionProfile(draft, "vnc-test"));

    expect(markup).toContain("VNC");
    expect(markup).toContain("screen.example.com");
    expect(markup).not.toContain("使用者名稱");
    expect(markup).not.toContain("stale-user");
  });

  it("offers only native mobile protocols for a new profile", () => {
    const markup = renderDrawer(null, {
      supportedProtocols: ["ssh", "sftp", "lattice"],
      mobile: true,
    });

    expect(
      markup.match(/class="protocol-option(?: is-selected)?"/g),
    ).toHaveLength(3);
    expect(markup).toContain("SSH");
    expect(markup).toContain("SFTP");
    expect(markup).toContain("REMOTE");
    expect(markup).not.toContain(">RDP<");
    expect(markup).not.toContain(">VNC<");
    expect(markup).toContain("儲存並連線");
  });

  it("keeps an existing desktop-only profile editable on mobile", () => {
    const profile = createConnectionProfile(
      {
        ...emptyDraft("rdp"),
        name: "Office PC",
        hostname: "desktop.example.com",
        username: "operator",
      },
      "rdp-mobile",
    );
    const markup = renderDrawer(profile, {
      supportedProtocols: ["ssh", "sftp", "lattice"],
      mobile: true,
    });

    expect(
      markup.match(/class="protocol-option(?: is-selected)?"/g),
    ).toHaveLength(4);
    expect(markup).toContain("Office PC");
    expect(markup).toContain("desktop.example.com");
    expect(markup).toContain("operator");
    expect(markup).toContain("這個裝置只能管理此連線");
    expect(markup).toContain("桌面版連線");
    expect(markup).toContain(">儲存<");
    expect(markup).not.toContain("儲存並連線");
  });

  it("explains direct mode without asking for a Remote username", () => {
    const draft = {
      ...emptyDraft("lattice"),
      name: "Office Remote",
      hostname: "192.0.2.10",
      username: "stale-user",
    };
    const markup = renderDrawer(
      createConnectionProfile(draft, "remote-test"),
    );

    expect(markup).toContain("加密直連模式");
    expect(markup).toContain("以 ID 連線");
    expect(markup).not.toContain("使用者名稱");
    expect(markup).not.toContain("stale-user");
  });
});
