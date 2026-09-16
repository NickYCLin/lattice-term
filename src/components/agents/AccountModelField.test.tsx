import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { accountModelKey, type AccountModelOption } from "../../app/accountModels";
import { AccountModelField } from "./AccountModelField";

const normal: AccountModelOption = { definitionId: "codex", accountProfileId: null, model: "gpt-5.6", label: "Codex · GPT-5.6", disabled: false };
const proxy: AccountModelOption = { definitionId: "codex", accountProfileId: null, model: "", provider: "cliproxyapi", label: "Codex · CLIProxyAPI", disabled: false };

describe("Fleet account model picker", () => {
  it("shows a proxy model ID only for the selected proxy option", () => {
    const render = (value: AccountModelOption) => renderToStaticMarkup(<I18nProvider locale="zh-TW"><AccountModelField options={[normal, proxy]} value={value} allowCliProxyApi onChange={vi.fn()} /></I18nProvider>);
    expect(render(normal)).not.toContain("CLIProxyAPI 模型 ID");
    const html = render({ ...proxy, model: "gpt-5.6-sol" });
    expect(html).toContain("CLIProxyAPI 模型 ID");
    expect(html).toContain('value="gpt-5.6-sol"');
    expect(html).toContain(`value="${accountModelKey(proxy).replace(/"/g, "&quot;")}" selected=""`);
  });

  it("does not add the proxy ID field to the shared chat picker", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="zh-TW"><AccountModelField options={[normal]} value={normal} onChange={vi.fn()} /></I18nProvider>);
    expect(html).not.toContain("CLIProxyAPI 模型 ID");
  });
});
