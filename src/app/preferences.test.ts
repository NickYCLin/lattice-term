import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultPreferences, readStoredPreferences, sanitizePreferences } from "./preferences";

afterEach(() => { vi.unstubAllGlobals(); });

describe("stored language preference", () => {
  function setup(languages: string[], stored: string | null = null) {
    vi.stubGlobal("navigator", { languages, language: languages[0] });
    vi.stubGlobal("localStorage", { getItem: () => stored });
  }

  it.each([["en-US", "en"], ["zh-TW", "zh-TW"], ["zh-CN", "zh-CN"], ["nl-NL", "en"]])(
    "starts a fresh profile in %s as %s",
    (tag, expected) => {
      setup([tag]);
      expect(readStoredPreferences().locale).toBe(expected);
    },
  );

  it("preserves a saved choice even when the system language differs", () => {
    setup(["en-US"], JSON.stringify({ locale: "zh-TW" }));
    expect(readStoredPreferences().locale).toBe("zh-TW");
    setup(["zh-TW"], JSON.stringify({ locale: "en" }));
    expect(readStoredPreferences().locale).toBe("en");
  });

  it.each(['{"theme":"light"}', '{"locale":"unknown"}', "null", "{broken"])(
    "uses the system language for missing or invalid settings: %s",
    (stored) => {
      setup(["ja-JP"], stored);
      expect(readStoredPreferences().locale).toBe("ja");
    },
  );

  it("still chooses a language when storage is unavailable", () => {
    setup(["fr-FR"]);
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); } });
    expect(readStoredPreferences().locale).toBe("fr");
  });

  it("supports WebViews exposing only a single language and environments without a navigator", () => {
    vi.stubGlobal("navigator", { language: "zh-HK" });
    expect(sanitizePreferences({}).locale).toBe("zh-TW");
    vi.stubGlobal("navigator", undefined);
    expect(sanitizePreferences({}).locale).toBe("en");
  });
});

describe("sanitizePreferences", () => {
  it.each([
    ["sand", "linen"], ["midnight", "dusk"], ["contrast", "clarity"],
    ["graphite", "dark"], ["nordic", "dark"], ["unknown", "dark"],
    ["system", "system"], ["light", "light"],
  ])("migrates theme %s to %s", (old, current) => {
    expect(sanitizePreferences({ theme: old as never }).theme).toBe(current);
  });
  it("preserves explicit full motion and rejects unknown choices", () => {
    expect(sanitizePreferences({ motion: "full" }).motion).toBe("full");
    expect(sanitizePreferences({ motion: "invalid" as never }).motion).toBe("system");
  });
  it("migrates older preferences to secure vault defaults", () => {
    const preferences = sanitizePreferences({ theme: "light" });

    expect(preferences.theme).toBe("light");
    expect(preferences.vaultAutoLock).toBe("15");
    expect(preferences.vaultLockOnBackground).toBe(true);
    expect(preferences.sensitiveClipboardClear).toBe("30");
  });

  it("preserves explicit auto-lock choices", () => {
    const preferences = sanitizePreferences({
      vaultAutoLock: "off",
      vaultLockOnBackground: false,
      sensitiveClipboardClear: "off",
    });

    expect(preferences.vaultAutoLock).toBe("off");
    expect(preferences.vaultLockOnBackground).toBe(false);
    expect(preferences.sensitiveClipboardClear).toBe("off");
  });

  it("rejects malformed security preferences", () => {
    const preferences = sanitizePreferences({
      vaultAutoLock: "999" as never,
      vaultLockOnBackground: "yes" as never,
      sensitiveClipboardClear: "999" as never,
    });

    expect(preferences.vaultAutoLock).toBe(defaultPreferences.vaultAutoLock);
    expect(preferences.vaultLockOnBackground).toBe(
      defaultPreferences.vaultLockOnBackground,
    );
    expect(preferences.sensitiveClipboardClear).toBe(
      defaultPreferences.sensitiveClipboardClear,
    );
    expect(preferences.agentCompletionSound).toBe(
      defaultPreferences.agentCompletionSound,
    );
  });
  it.each([["clear", "glass"], ["gentle", "bloom"], ["double", "pulse"], ["wood", "marimba"], ["off", "off"]])("migrates legacy sound %s without unmuting it", (old, current) => {
    const result = sanitizePreferences({ agentCompletionSound: old as never });
    expect(result.agentCompletionSound).toBe(current);
    expect(result.chatCompletionSound).toBe(current);
  });
  it("preserves separate event choices and bounds volume", () => {
    expect(sanitizePreferences({ agentCompletionSound: "off", chatCompletionSound: "arcade", notificationVolume: 0 })).toMatchObject({ agentCompletionSound: "off", chatCompletionSound: "arcade", notificationVolume: 0 });
    for (const [input, expected] of [[NaN, 60], [Infinity, 60], [-1, 0], [101, 100], [25.6, 26]]) {
      expect(sanitizePreferences({ notificationVolume: input }).notificationVolume).toBe(expected);
    }
  });


  it.each(["zh-CN", "ja", "ko", "es", "fr", "de"] as const)(
    "preserves the supported %s locale",
    (locale) => {
      expect(sanitizePreferences({ locale }).locale).toBe(locale);
    },
  );
});
