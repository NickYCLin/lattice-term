import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { accountModelKey, type AccountModelOption } from "../../app/accountModels";
import { AccountModelField } from "./AccountModelField";

const normal: AccountModelOption = { definitionId: "codex", accountProfileId: null, model: "gpt-5.6", label: "Codex · GPT-5.6", disabled: false };
const proxy: AccountModelOption = { definitionId: "codex", accountProfileId: null, model: "", provider: "cliproxyapi", proxyId: "default", label: "工作代理", disabled: false };
const spare: AccountModelOption = { ...proxy, proxyId: "7f3a91", label: "備援代理" };

describe("Fleet account model picker", () => {
  it("puts every proxy account before native models without changing the selection", () => {
    const teamNormal = { ...normal, accountProfileId: "team", label: "團隊 · Codex · GPT-5.6", disabled: true };
    const teamProxy = { ...proxy, accountProfileId: "team", label: "團隊 · 工作代理" };
    const html = renderToStaticMarkup(<I18nProvider locale="zh-TW"><AccountModelField options={[normal, proxy, teamNormal, teamProxy]} value={normal} allowCliProxyApi onChange={vi.fn()} /></I18nProvider>);
    const group = html.match(/<optgroup label="CLIProxyAPI">(.*?)<\/optgroup>/)?.[1];
    expect(group).toBeDefined();
    expect(group).toContain(proxy.label);
    expect(group).toContain(teamProxy.label);
    expect(group).not.toContain(normal.label);
    expect(html.indexOf("</optgroup>")).toBeLessThan(html.indexOf(normal.label));
    expect(html.match(/<option /g)).toHaveLength(4);
    expect(html).toContain(`value="${accountModelKey(normal).replace(/"/g, "&quot;")}" selected=""`);
    expect(html).toContain(`value="${accountModelKey(teamNormal).replace(/"/g, "&quot;")}" disabled=""`);
  });

  it("shows a proxy model ID only for the selected proxy option", () => {
    const render = (value: AccountModelOption) => renderToStaticMarkup(<I18nProvider locale="zh-TW"><AccountModelField options={[normal, proxy]} value={value} allowCliProxyApi onChange={vi.fn()} /></I18nProvider>);
    expect(render(normal)).not.toContain("CLIProxyAPI 模型 ID");
    const html = render({ ...proxy, model: "gpt-5.6-sol" });
    expect(html).toContain("CLIProxyAPI 模型 ID");
    expect(html).toContain('value="gpt-5.6-sol"');
    expect(html).toContain(`value="${accountModelKey(proxy).replace(/"/g, "&quot;")}" selected=""`);
  });

  it("offers the proxy's own models and keeps typing one available", () => {
    const models = { state: "ready", models: [
      { id: "gpt-image-2.5-flare", ownedBy: "openai" },
      { id: "gpt-5.6-sol", ownedBy: "openai" },
      { id: "claude-opus-5", ownedBy: null },
    ] } as const;
    const html = renderToStaticMarkup(<I18nProvider locale="zh-TW"><AccountModelField options={[normal, proxy]} value={{ ...proxy, model: "gpt-5.6-sol" }} allowCliProxyApi proxyModels={{ default: models }} onChange={vi.fn()} /></I18nProvider>);
    // Same brand shares one group and the stronger model comes first.
    const brand = html.match(/<optgroup label="openai">(.*?)<\/optgroup>/)?.[1] ?? "";
    expect(brand).not.toBe("");
    expect(brand.indexOf("gpt-5.6-sol")).toBeLessThan(brand.indexOf("gpt-image-2.5-flare"));
    expect(html).toContain("claude-opus-5");
    expect(html).toContain("其他──自己填模型 ID");
    // A model the list already offers does not also get a free-text box.
    expect(html).not.toContain('placeholder="gpt-5.6-sol"');
  });

  it("falls back to typing an ID when the list is unavailable or unknown", () => {
    const render = (proxyModels: Parameters<typeof AccountModelField>[0]["proxyModels"], model: string) =>
      renderToStaticMarkup(<I18nProvider locale="zh-TW"><AccountModelField options={[normal, proxy]} value={{ ...proxy, model }} allowCliProxyApi proxyModels={proxyModels} onChange={vi.fn()} /></I18nProvider>);

    const unavailable = render({ default: { state: "unavailable", reason: "cliproxy.models.unauthorized" } }, "");
    expect(unavailable).toContain("代理拒絕了這把金鑰");
    expect(unavailable).toContain('placeholder="gpt-5.6-sol"');

    // A model the proxy did not list is still launchable; the picker switches
    // itself to the manual entry rather than silently dropping the value.
    const models = { state: "ready", models: [{ id: "gpt-5.6-sol", ownedBy: null }] } as const;
    const unknown = render({ default: models }, "gpt-5.6-terra");
    expect(unknown).toContain('value="gpt-5.6-terra"');
    expect(unknown).toContain('placeholder="gpt-5.6-sol"');
  });

  it("asks the chosen proxy for its models, not whichever one was saved first", () => {
    const lists = {
      default: { state: "ready", models: [{ id: "gpt-5.6-sol", ownedBy: null }] },
      "7f3a91": { state: "ready", models: [{ id: "claude-opus-5", ownedBy: null }] },
    } as const;
    const html = renderToStaticMarkup(<I18nProvider locale="zh-TW"><AccountModelField options={[normal, proxy, spare]} value={{ ...spare, model: "claude-opus-5" }} allowCliProxyApi proxyModels={lists} onChange={vi.fn()} /></I18nProvider>);
    const group = html.match(/<optgroup label="CLIProxyAPI">(.*?)<\/optgroup>/)?.[1] ?? "";
    expect(group).toContain("工作代理");
    expect(group).toContain("備援代理");
    expect(html).toContain("claude-opus-5");
    expect(html).not.toContain("gpt-5.6-sol");
  });

  it("offers a retry next to a failed model list instead of sending the user to settings", () => {
    const render = (models: Parameters<typeof AccountModelField>[0]["proxyModels"], onReload?: () => void) =>
      renderToStaticMarkup(<I18nProvider locale="zh-TW"><AccountModelField options={[normal, proxy]} value={{ ...proxy, model: "" }} allowCliProxyApi proxyModels={models} onReloadProxyModels={onReload} onChange={vi.fn()} /></I18nProvider>);

    const failed = render({ default: { state: "unavailable", reason: "cliproxy.models.unreadable" } }, vi.fn());
    expect(failed).toContain("重新詢問");
    expect(failed).toContain('role="alert"');
    // The failure never picks a model on the user's behalf.
    expect(failed).toContain('placeholder="gpt-5.6-sol"');
    // Nothing failed, so there is nothing to ask again.
    expect(render({ default: { state: "ready", models: [{ id: "gpt-5.6-sol", ownedBy: null }] } }, vi.fn())).not.toContain("重新詢問");
    // A caller that cannot reload keeps the error without a dead button.
    const noHandler = render({ default: { state: "unavailable", reason: "cliproxy.models.unreadable" } });
    expect(noHandler).toContain("回來的不是模型清單");
    expect(noHandler).not.toContain("重新詢問");
  });

  it("does not add the proxy ID field to the shared chat picker", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="zh-TW"><AccountModelField options={[normal]} value={normal} onChange={vi.fn()} /></I18nProvider>);
    expect(html).not.toContain("CLIProxyAPI 模型 ID");
  });
});
