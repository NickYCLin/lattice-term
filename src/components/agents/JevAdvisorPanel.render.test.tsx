import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { JevAdvisorPanel } from "./JevAdvisorPanel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

it("starts disabled and explains signup, temporary keys and per-request review", () => {
  const html = renderToStaticMarkup(<I18nProvider locale="zh-TW"><JevAdvisorPanel sessions={[]} /></I18nProvider>);
  expect(html).toContain("預設關閉");
  expect(html).toContain("如何申請與開始使用");
  expect(html).toContain("Google");
  expect(html).toContain('type="password"');
  expect(html).toContain("啟用本次使用");
  expect(html).not.toContain("送出這段內容分析");
});
