import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { HerdrPane } from "./HerdrPane";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

it("labels Herdr as terminal output rather than complete imported history", () => {
  const markup = renderToStaticMarkup(<I18nProvider locale="zh-TW"><HerdrPane enabled /></I18nProvider>);
  expect(markup).toContain("最近 500 行終端輸出");
  expect(markup).toContain("不是完整原生對話紀錄");
  expect(markup).toContain('value="default"');
  expect(markup).not.toContain('type="file"');
  expect(invoke).not.toHaveBeenCalled();
});

it("does not offer connection controls outside the desktop backend", () => {
  const markup = renderToStaticMarkup(<I18nProvider locale="en"><HerdrPane enabled={false} /></I18nProvider>);
  expect(markup).not.toContain("<form");
  expect(invoke).not.toHaveBeenCalled();
});
