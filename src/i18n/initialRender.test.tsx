import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from ".";
import { useI18n } from "./context";

function CloseButton() {
  const { t } = useI18n();
  return <button>{t("common.close")}</button>;
}

it("uses English while a non-Chinese catalogue is loading", () => {
  expect(renderToStaticMarkup(
    <I18nProvider locale="de"><CloseButton /></I18nProvider>,
  )).toBe("<button>Close</button>");
});

it("renders Traditional Chinese immediately when it is selected", () => {
  expect(renderToStaticMarkup(
    <I18nProvider locale="zh-TW"><CloseButton /></I18nProvider>,
  )).toBe("<button>關閉</button>");
});
