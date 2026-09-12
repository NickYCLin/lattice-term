/**
 * Interface preferences: appearance, layout and local security policy.
 *
 * They are written to `localStorage` because losing them is harmless; the
 * security entries select local lock timing only. No secret or connection
 * data is stored here.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { defaultLocale, localeCatalog, type Locale } from "../i18n/catalog";
import {
  normalizeNotificationSound,
  normalizeNotificationVolume,
  type NotificationSoundChoice,
} from "./notificationSounds";
import { normalizeTheme, resolveTheme, type ThemeChoice, type ThemeId } from "./themes";

export type DensityChoice = "comfortable" | "compact";
export type MotionChoice = "system" | "full" | "reduced";
export type VaultAutoLockChoice = "off" | "5" | "15" | "30" | "60";
export type SensitiveClipboardClearChoice =
  | "off"
  | "15"
  | "30"
  | "60"
  | "120";

export interface Preferences {
  theme: ThemeChoice;
  locale: Locale;
  density: DensityChoice;
  motion: MotionChoice;
  vaultAutoLock: VaultAutoLockChoice;
  vaultLockOnBackground: boolean;
  sensitiveClipboardClear: SensitiveClipboardClearChoice;
  sidebarCollapsed: boolean;
  inspectorOpen: boolean;
  checkUpdatesOnLaunch: boolean;
  agentCompletionSound: NotificationSoundChoice;
  chatCompletionSound: NotificationSoundChoice;
  notificationVolume: number;
}

export const defaultPreferences: Preferences = {
  theme: "dark",
  locale: defaultLocale,
  density: "comfortable",
  motion: "system",
  vaultAutoLock: "15",
  vaultLockOnBackground: true,
  sensitiveClipboardClear: "30",
  sidebarCollapsed: false,
  inspectorOpen: true,
  checkUpdatesOnLaunch: true,
  agentCompletionSound: "bloom",
  chatCompletionSound: "bloom",
  notificationVolume: 60,
};

const STORAGE_KEY = "latticeterm.preferences.v2";

const knownLocales = new Set<string>(localeCatalog.map((entry) => entry.id));
const knownVaultAutoLockChoices = new Set<string>([
  "off",
  "5",
  "15",
  "30",
  "60",
]);
const knownSensitiveClipboardClearChoices = new Set<string>([
  "off",
  "15",
  "30",
  "60",
  "120",
]);

/**
 * Ignores anything unrecognised, so an older file or a hand-edited one cannot
 * leave the app painted in a theme that no longer exists.
 */
export function sanitizePreferences(stored: Partial<Preferences>): Preferences {
  return {
    theme: normalizeTheme(stored.theme),
    locale: knownLocales.has(String(stored.locale))
      ? (stored.locale as Locale)
      : defaultPreferences.locale,
    density: stored.density === "compact" ? "compact" : "comfortable",
    motion: stored.motion === "full" || stored.motion === "reduced" ? stored.motion : "system",
    vaultAutoLock: knownVaultAutoLockChoices.has(String(stored.vaultAutoLock))
      ? (stored.vaultAutoLock as VaultAutoLockChoice)
      : defaultPreferences.vaultAutoLock,
    vaultLockOnBackground:
      typeof stored.vaultLockOnBackground === "boolean"
        ? stored.vaultLockOnBackground
        : defaultPreferences.vaultLockOnBackground,
    sensitiveClipboardClear: knownSensitiveClipboardClearChoices.has(
      String(stored.sensitiveClipboardClear),
    )
      ? (stored.sensitiveClipboardClear as SensitiveClipboardClearChoice)
      : defaultPreferences.sensitiveClipboardClear,
    sidebarCollapsed: Boolean(stored.sidebarCollapsed),
    inspectorOpen: stored.inspectorOpen !== false,
    checkUpdatesOnLaunch: stored.checkUpdatesOnLaunch !== false,
    agentCompletionSound: normalizeNotificationSound(stored.agentCompletionSound),
    chatCompletionSound: normalizeNotificationSound(stored.chatCompletionSound ?? stored.agentCompletionSound),
    notificationVolume: normalizeNotificationVolume(stored.notificationVolume),
  };
}

function readStored(): Preferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultPreferences;
    return sanitizePreferences(JSON.parse(raw) as Partial<Preferences>);
  } catch {
    return defaultPreferences;
  }
}

export interface PreferencesValue {
  preferences: Preferences;
  update: (patch: Partial<Preferences>) => void;
  /** The theme actually painted right now, with `system` already resolved. */
  activeTheme: ThemeId;
}

export function usePreferences(): PreferencesValue {
  const [preferences, setPreferences] = useState<Preferences>(readStored);
  const [systemTheme, setSystemTheme] = useState<ThemeId>(() =>
    resolveTheme("system"),
  );

  const update = useCallback((patch: Partial<Preferences>) => {
    setPreferences((current) => ({ ...current, ...patch }));
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      // Quota or private-mode failures are not worth interrupting anyone for.
    }
  }, [preferences]);

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: light)");
    if (!query) return;

    const apply = () => setSystemTheme(query.matches ? "light" : "dark");
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  const activeTheme =
    preferences.theme === "system" ? systemTheme : preferences.theme;

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = activeTheme;
    root.dataset.density = preferences.density;
    root.dataset.motion = preferences.motion;
    root.lang =
      localeCatalog.find((entry) => entry.id === preferences.locale)?.tag ??
      "zh-Hant-TW";
  }, [activeTheme, preferences.density, preferences.motion, preferences.locale]);

  return useMemo(
    () => ({ preferences, update, activeTheme }),
    [preferences, update, activeTheme],
  );
}
