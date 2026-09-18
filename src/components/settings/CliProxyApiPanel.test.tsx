import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n";
import { CliProxyApiPanel } from "./CliProxyApiPanel";

describe("CLIProxyAPI settings", () => {
  it.each(["zh-TW", "en"] as const)("states what stays with the user in %s", (locale) => {
    const html = renderToStaticMarkup(<I18nProvider locale={locale}><CliProxyApiPanel available /></I18nProvider>);
    expect(html).not.toContain("settings.cliProxy.");
    expect(html).toContain(locale === "zh-TW" ? "只讀位址與模型清單" : "reads only the address and the model list");
    expect(html).toContain(locale === "zh-TW" ? "之後不會再顯示" : "never shows it again");
    expect(html).toContain("http://127.0.0.1:8317");
  });

  it("never renders the saved key back into the page", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en"><CliProxyApiPanel available /></I18nProvider>);
    // The key field is write-only: it starts empty and is masked.
    expect(html).toContain('type="password"');
    expect(html).toContain('value=""');
  });

  it("offers nothing to press without the desktop backend", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en"><CliProxyApiPanel available={false} /></I18nProvider>);
    expect(html).toContain("Requires the desktop application.");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<input");
  });
});
