import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { CLI_PROXY_SETTINGS_KEY } from "../../app/cliProxyApi";
import { CliProxyApiPanel } from "./CliProxyApiPanel";

function withSavedProxies(proxies: readonly { id: string; label: string; baseUrl: string }[]) {
  const values = new Map([[CLI_PROXY_SETTINGS_KEY, JSON.stringify({ proxies })]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("CLIProxyAPI settings", () => {
  it.each(["zh-TW", "en"] as const)("states what stays with the user in %s", (locale) => {
    withSavedProxies([{ id: "default", label: "", baseUrl: "http://127.0.0.1:8317" }]);
    const html = renderToStaticMarkup(<I18nProvider locale={locale}><CliProxyApiPanel available /></I18nProvider>);
    expect(html).not.toContain("settings.cliProxy.");
    expect(html).toContain(locale === "zh-TW" ? "不會寫入 CLI 設定檔" : "without writing the key to CLI configuration files");
    expect(html).toContain(locale === "zh-TW" ? "之後不會再顯示" : "never shows it again");
    expect(html).toContain("http://127.0.0.1:8317");
  });

  it("lists every configured proxy under its own name", () => {
    withSavedProxies([
      { id: "default", label: "工作", baseUrl: "http://127.0.0.1:8317" },
      { id: "7f3a91", label: "", baseUrl: "http://192.168.1.20:8317" },
    ]);
    const html = renderToStaticMarkup(<I18nProvider locale="zh-TW"><CliProxyApiPanel available /></I18nProvider>);
    expect(html.match(/class="cli-proxy-entry"/g)).toHaveLength(2);
    expect(html).toContain("工作");
    // An unnamed proxy is still told apart by the address it answers on.
    expect(html).toContain("192.168.1.20:8317");
  });

  it("says the list is empty before anything is added", () => {
    withSavedProxies([]);
    const html = renderToStaticMarkup(<I18nProvider locale="zh-TW"><CliProxyApiPanel available /></I18nProvider>);
    expect(html).toContain("還沒加入代理");
    expect(html).toContain("新增代理");
    expect(html).not.toContain("cli-proxy-entry");
  });

  it("never renders the saved key back into the page", () => {
    withSavedProxies([{ id: "default", label: "", baseUrl: "http://127.0.0.1:8317" }]);
    const html = renderToStaticMarkup(<I18nProvider locale="en"><CliProxyApiPanel available /></I18nProvider>);
    // The key field is write-only: it starts empty and is masked.
    expect(html).toContain('type="password"');
    expect(html).toContain('value=""');
  });

  it("offers nothing to press without the desktop backend", () => {
    withSavedProxies([{ id: "default", label: "", baseUrl: "http://127.0.0.1:8317" }]);
    const html = renderToStaticMarkup(<I18nProvider locale="en"><CliProxyApiPanel available={false} /></I18nProvider>);
    expect(html).toContain("Requires the desktop application.");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<input");
  });
});
