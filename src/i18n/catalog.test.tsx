import { beforeAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { catalogues, loadCatalogue, localeCatalog } from "./catalog";
import { zhTW } from "./messages/zh-TW";
import { I18nProvider } from ".";
import { useI18n } from "./context";
import { sanitizePreferences } from "../app/preferences";

const placeholders = (text: string) => [...text.matchAll(/\{\w+\}/g)].map(match => match[0]).sort();
beforeAll(async () => { await Promise.all(localeCatalog.map(locale => loadCatalogue(locale.id))); });
describe.each(localeCatalog)("$label catalogue", ({ id, tag }) => {
  it("contains every key with the same interpolation parameters", () => {
    const messages = catalogues[id]!;
    expect(Object.keys(messages).sort()).toEqual(Object.keys(zhTW).sort());
    for (const [key, original] of Object.entries(zhTW)) {
      const value = messages[key as keyof typeof messages];
      expect(value.trim(), `${id}:${key}`).not.toBe("");
      expect(placeholders(value), `${id}:${key}`).toEqual(placeholders(original));
      expect(value, `${id}:${key}`).not.toMatch(/▁|990000\d{3}|<unk>/);
      expect(value, `${id}:${key}`).not.toMatch(/&(?:amp|quot|lt|gt);|&#\d+;/);
    }
  });
  it("persists the selection and renders translated text and dates", () => {
    expect(sanitizePreferences({ locale: id }).locale).toBe(id);
    function Probe() {
      const { t, tag: activeTag } = useI18n();
      return <p lang={activeTag}>{t("common.close")} {t("connections.count", { count: 7 })}</p>;
    }
    const html = renderToStaticMarkup(<I18nProvider locale={id}><Probe /></I18nProvider>);
    expect(html).toContain(`lang="${tag}"`);
    expect(html).toContain(catalogues[id]!["common.close"]);
    expect(html).toContain("7");
    expect(html).not.toContain("{count}");
    expect(new Intl.DateTimeFormat(tag).format(new Date(2026, 8, 13))).toBeTruthy();
    expect(new Intl.NumberFormat(tag).format(1234.5)).toBeTruthy();
  });
});
it("offers precisely the nine requested locales", () => {
  expect(localeCatalog.map(locale => locale.id)).toEqual(["zh-TW", "en", "zh-CN", "ja", "ko", "es", "fr", "de", "pt-BR"]);
});
