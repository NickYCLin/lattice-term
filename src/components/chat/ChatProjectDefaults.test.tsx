import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { I18nProvider } from "../../i18n";
import { ChatProjectDefaults } from "./ChatProjectDefaults";

it("explains how to edit defaults and disables saving without an eligible conversation", () => {
  const markup = renderToStaticMarkup(<I18nProvider locale="zh-TW"><ChatProjectDefaults defaults={null}
    canSave={false} notice={null} onSave={() => {}} onClear={() => {}} /></I18nProvider>);
  expect(markup).toContain("在對話設定調整");
  expect(markup).toContain("不更動現有對話");
  expect(markup).toContain('disabled=""');
  expect(markup).toContain("新對話沿用最近的對話設定");
});

it("shows saved source, model and access plus a recoverable error", () => {
  const markup = renderToStaticMarkup(<I18nProvider locale="zh-TW"><ChatProjectDefaults
    defaults={{ definitionId: "codex", provider: "cliproxyapi", proxyId: "proxy", model: "test-model",
      permission: "full", accountProfileId: null }} canSave notice="代理已不存在"
    onSave={() => {}} onClear={() => {}} /></I18nProvider>);
  expect(markup).toContain("CLIProxyAPI · test-model");
  expect(markup).not.toContain('disabled=""');
  expect(markup).toContain('role="status"');
  expect(markup).toContain("代理已不存在");
  expect(markup).toContain("改回沿用最近設定");
});
