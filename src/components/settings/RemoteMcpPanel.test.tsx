import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n";
import { RemoteMcpPanel } from "./RemoteMcpPanel";

describe("remote MCP permissions", () => {
  it.each(["zh-TW", "en"] as const)("explains opt-in and revocation boundaries in %s", (locale) => {
    const html = renderToStaticMarkup(<I18nProvider locale={locale}><RemoteMcpPanel available /></I18nProvider>);
    expect(html).not.toContain("settings.mcpRemote.");
    expect(html).toContain(locale === "zh-TW" ? "預設全部關閉" : "Off by default");
    expect(html).toContain(locale === "zh-TW" ? "不會自動登入" : "Never logs in");
    expect(html).not.toContain("<form");
  });
  it("does not offer browser-only grants", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en"><RemoteMcpPanel available={false} /></I18nProvider>);
    expect(html).toContain("Requires the desktop backend");
    expect(html).not.toContain("<button");
  });
});
