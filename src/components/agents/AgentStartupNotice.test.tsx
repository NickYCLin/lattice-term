import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { I18nProvider } from "../../i18n";
import { AgentStartupNotice } from "./AgentStartupNotice";

it("keeps an unsent startup warning outside terminal output", () => {
  const html = renderToStaticMarkup(<I18nProvider locale="zh-TW"><AgentStartupNotice unconfirmed /></I18nProvider>);
  expect(html).toContain('role="status"');
  expect(html).toContain("啟動指示或記憶交接未確認送出");
  expect(html).toContain("此提示不會寫入終端或送給助理");
  expect(html).not.toContain("xterm");
  expect(html).not.toContain("[LatticeTerm]");
});

it("does not reserve space for sessions without a warning", () => {
  expect(renderToStaticMarkup(<I18nProvider locale="zh-TW"><AgentStartupNotice /></I18nProvider>)).toBe("");
});
