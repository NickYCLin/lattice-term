/** Application themes. Preview cards share the palettes in tokens.css. */
import type { MessageKey } from "../i18n/messages/zh-TW";

export const themeIds = ["dark", "light", "dusk", "linen", "clarity"] as const;
export type ThemeId = (typeof themeIds)[number];
export type ThemeChoice = "system" | ThemeId;
export interface ThemeDefinition {
  id: ThemeChoice;
  labelKey: MessageKey;
  hintKey: MessageKey;
  isDark: boolean;
}
export const themeCatalog: ThemeDefinition[] = [
  {
    id: "dark",
    labelKey: "theme.dark",
    hintKey: "theme.dark.hint",
    isDark: true,
  },
  {
    id: "light",
    labelKey: "theme.light",
    hintKey: "theme.light.hint",
    isDark: false,
  },
  {
    id: "dusk",
    labelKey: "theme.dusk",
    hintKey: "theme.dusk.hint",
    isDark: true,
  },
  {
    id: "linen",
    labelKey: "theme.linen",
    hintKey: "theme.linen.hint",
    isDark: false,
  },
  {
    id: "clarity",
    labelKey: "theme.clarity",
    hintKey: "theme.clarity.hint",
    isDark: true,
  },
  {
    id: "system",
    labelKey: "theme.system",
    hintKey: "theme.system.hint",
    isDark: true,
  },
];

/** Preserve brightness preferences without retaining retired palettes. */
export function normalizeTheme(value: unknown): ThemeChoice {
  if (typeof value !== "string") return "dark";
  if (value === "system" || themeIds.includes(value as ThemeId))
    return value as ThemeChoice;
  switch (value) {
    case "sand":
      return "linen";
    case "midnight":
      return "dusk";
    case "contrast":
      return "clarity";
    default:
      return "dark";
  }
}
export function findTheme(id: ThemeChoice): ThemeDefinition {
  return themeCatalog.find((theme) => theme.id === id) ?? themeCatalog[0];
}

/** `system` follows the desktop; every other choice is taken literally. */
export function resolveTheme(choice: ThemeChoice): ThemeId {
  if (choice !== "system") return choice;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

/** The theme the quick toggle in the rail should switch to next. */
export function oppositeTheme(current: ThemeId): ThemeId {
  return findTheme(current).isDark ? "light" : "dark";
}
