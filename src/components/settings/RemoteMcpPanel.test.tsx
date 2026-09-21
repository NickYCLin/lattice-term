import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n";
import type { ConnectionProfile } from "../../domain/connection";
import { RemoteMcpPanel, savedProfilesNotConnected } from "./RemoteMcpPanel";

describe("remote MCP permissions", () => {
  it("offers every saved connection protocol that is not already live", () => {
    const profiles = (["ssh", "sftp", "rdp", "vnc", "lattice"] as const).map((protocol) => ({
      id: `saved-${protocol}`,
      name: protocol,
      protocol,
    })) as ConnectionProfile[];
    const offline = savedProfilesNotConnected(profiles, [{
      sessionId: "live-ssh",
      profileId: "saved-ssh",
      host: "redacted",
      backend: "ssh",
    }]);

    expect(offline.map((profile) => profile.protocol)).toEqual(["sftp", "rdp", "vnc", "lattice"]);
  });

  it.each(["zh-TW", "en"] as const)("says what an AI reaches and how to take it back in %s", (locale) => {
    const html = renderToStaticMarkup(<I18nProvider locale={locale}><RemoteMcpPanel available /></I18nProvider>);
    expect(html).not.toContain("settings.mcpRemote.");
    // Nothing to fill in: the panel reports what is open and how to stop it.
    expect(html).toContain(locale === "zh-TW" ? "不需要逐項授權" : "Nothing is granted item by item");
    expect(html).toContain(locale === "zh-TW" ? "每次仍會跳出來等你同意" : "still waits for you, every time");
    expect(html).toContain(locale === "zh-TW" ? "目前沒有連線" : "No connection is open");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<select");
  });
  it("does not offer browser-only grants", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en"><RemoteMcpPanel available={false} /></I18nProvider>);
    expect(html).toContain("Requires the desktop backend");
    expect(html).not.toContain("<button");
  });

  it.each(["zh-TW", "en"] as const)("makes the connection book its own choice in %s", (locale) => {
    const html = renderToStaticMarkup(<I18nProvider locale={locale}><RemoteMcpPanel available /></I18nProvider>);
    expect(html).toContain(locale === "zh-TW" ? "允許外部 AI 讀取連線簿" : "Let external AI read the connection book");
    // The book names places to work; the way into them is never part of it.
    expect(html).toContain(locale === "zh-TW" ? "不含主機、埠、帳號與任何憑證" : "Never the host, port, account or any credential");
    expect(html).toContain('type="checkbox"');
  });

  it("shows the connection book as readable by default", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en"><RemoteMcpPanel available /></I18nProvider>);
    expect(html).toContain('checked=""');
  });
});
