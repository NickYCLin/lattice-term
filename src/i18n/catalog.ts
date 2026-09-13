/** Locale metadata stays small; additional catalogues load on demand. */
import { en } from "./messages/en";
import { zhTW, type Messages } from "./messages/zh-TW";

export type Locale = "zh-TW" | "en" | "zh-CN" | "ja" | "ko" | "es" | "fr" | "de" | "pt-BR";
export const defaultLocale: Locale = "zh-TW";
export const localeCatalog: { id: Locale; label: string; tag: string }[] = [
  { id: "zh-TW", label: "繁體中文", tag: "zh-Hant-TW" },
  { id: "en", label: "English", tag: "en" },
  { id: "zh-CN", label: "简体中文", tag: "zh-Hans-CN" },
  { id: "ja", label: "日本語", tag: "ja-JP" },
  { id: "ko", label: "한국어", tag: "ko-KR" },
  { id: "es", label: "Español", tag: "es" },
  { id: "fr", label: "Français", tag: "fr-FR" },
  { id: "de", label: "Deutsch", tag: "de-DE" },
  { id: "pt-BR", label: "Português (Brasil)", tag: "pt-BR" },
];
export const catalogues: Partial<Record<Locale, Messages>> = { "zh-TW": zhTW, en };
const loaders = {
  "zh-CN": () => import("./messages/zh-CN"),
  ja: () => import("./messages/ja"),
  ko: () => import("./messages/ko"),
  es: () => import("./messages/es"),
  fr: () => import("./messages/fr"),
  de: () => import("./messages/de"),
  "pt-BR": () => import("./messages/pt-BR"),
};
const pending = new Map<Locale, Promise<Messages>>();
export async function loadCatalogue(locale: Locale): Promise<Messages> {
  const cached = catalogues[locale];
  if (cached) return cached;
  const loading = pending.get(locale);
  if (loading) return loading;
  const loader = loaders[locale as keyof typeof loaders];
  if (!loader) return zhTW;
  const request = loader().then(({ messages }) => {
    catalogues[locale] = messages;
    return messages;
  }).finally(() => { pending.delete(locale); });
  pending.set(locale, request);
  return request;
}
