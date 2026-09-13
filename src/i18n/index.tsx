/**
 * Interface localisation.
 *
 * Traditional Chinese is the default and the source of truth for the key set;
 * every other catalogue has to satisfy the same `Messages` type, so a missing
 * translation is a build error instead of a blank label.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { catalogues, loadCatalogue, localeCatalog, type Locale } from "./catalog";
import { I18nContext, type I18nValue, type TranslateValues } from "./context";
import { zhTW, type MessageKey } from "./messages/zh-TW";

/** Replaces `{name}` placeholders; unknown placeholders are left untouched. */
function interpolate(template: string, values?: TranslateValues): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

export function I18nProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: ReactNode;
}) {
  const [loaded, setLoaded] = useState(() => ({ locale, catalogue: catalogues[locale] ?? zhTW }));
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setLoadFailed(false);
    void loadCatalogue(locale).then(catalogue => {
      if (!cancelled) setLoaded({ locale, catalogue });
    }).catch(() => { if (!cancelled) setLoadFailed(true); });
    return () => { cancelled = true; };
  }, [locale]);
  const catalogue = catalogues[locale] ?? loaded.catalogue;
  const t = useCallback(
    (key: MessageKey, values?: TranslateValues) => {
      return interpolate(catalogue[key] ?? zhTW[key] ?? key, values);
    },
    [catalogue],
  );

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      t,
      tag: localeCatalog.find((entry) => entry.id === locale)?.tag ?? "zh-Hant-TW",
    }),
    [locale, t],
  );

  return <I18nContext.Provider value={value}>
    {loadFailed && <p role="alert">{t("language.loadFailed")}</p>}
    {children}
  </I18nContext.Provider>;
}
