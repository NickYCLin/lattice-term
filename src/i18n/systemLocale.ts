import { defaultLocale, type Locale } from "./catalog";

/** Use the OS/browser preferences exposed by the WebView on first launch. */
export function detectSystemLocale(
  languages: readonly string[] = typeof navigator === "undefined"
    ? []
    : navigator.languages?.length ? navigator.languages : [navigator.language],
): Locale {
  for (const language of languages) {
    try {
      const locale = new Intl.Locale(language);
      switch (locale.language) {
        case "zh":
          // An explicit script takes precedence over the region.
          return locale.maximize().script === "Hant" ? "zh-TW" : "zh-CN";
        case "en": return "en";
        case "ja": return "ja";
        case "ko": return "ko";
        case "es": return "es";
        case "fr": return "fr";
        case "de": return "de";
        case "pt": return "pt-BR";
      }
    } catch {
      // Missing or malformed WebView language tags must not prevent startup.
    }
  }
  return defaultLocale;
}
