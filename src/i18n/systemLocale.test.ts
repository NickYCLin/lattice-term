import { describe, expect, it } from "vitest";
import { detectSystemLocale } from "./systemLocale";

describe("first-launch language", () => {
  it.each([
    ["en-US", "en"], ["en-GB", "en"],
    ["zh-TW", "zh-TW"], ["zh-HK", "zh-TW"], ["zh-MO", "zh-TW"],
    ["zh-Hant", "zh-TW"], ["zh-Hant-CN", "zh-TW"],
    ["zh-CN", "zh-CN"], ["zh-SG", "zh-CN"], ["zh", "zh-CN"],
    ["zh-Hans-TW", "zh-CN"],
    ["ja-JP", "ja"], ["ko-KR", "ko"], ["es-MX", "es"],
    ["fr-CA", "fr"], ["de-AT", "de"], ["pt-PT", "pt-BR"],
    ["pt-BR", "pt-BR"],
  ])("maps %s to %s", (tag, expected) => {
    expect(detectSystemLocale([tag])).toBe(expected);
  });

  it("uses the first supported language in preference order", () => {
    expect(detectSystemLocale(["nl-NL", "de-DE", "en-US"])).toBe("de");
    expect(detectSystemLocale(["en-US", "zh-TW"])).toBe("en");
  });

  it.each([[], ["nl-NL"], ["C"], ["POSIX"], [""], ["invalid_tag"]])(
    "falls back to English for %j",
    (...tags) => { expect(detectSystemLocale(tags)).toBe("en"); },
  );
});
