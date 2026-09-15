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

  it.each(["zh-TW", "en"] as const)("explains opt-in and revocation boundaries in %s", (locale) => {
    const html = renderToStaticMarkup(<I18nProvider locale={locale}><RemoteMcpPanel available /></I18nProvider>);
    expect(html).not.toContain("settings.mcpRemote.");
    expect(html).toContain(locale === "zh-TW" ? "預設全部關閉" : "Off by default");
    expect(html).toContain(locale === "zh-TW" ? "安全儲存區開啟已儲存的連線" : "open a saved connection through secure storage");
    expect(html).toContain(locale === "zh-TW" ? "操作範圍" : "scope grant");
    expect(html).not.toContain("<form");
  });
  it("does not offer browser-only grants", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en"><RemoteMcpPanel available={false} /></I18nProvider>);
    expect(html).toContain("Requires the desktop backend");
    expect(html).not.toContain("<button");
  });
});
