import { describe, expect, it } from "vitest";
import { dictationMode, speakableText } from "./sessionVoice";

class FakeRecognition {}

describe("dictation mode", () => {
  it("uses system voice typing on Windows even when the web view has a recogniser", () => {
    expect(dictationMode({
      navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/141.0" },
      webkitSpeechRecognition: FakeRecognition,
    })).toBe("system");
  });

  it("uses the browser recogniser elsewhere when one exists", () => {
    expect(dictationMode({
      navigator: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)" },
      SpeechRecognition: FakeRecognition,
    })).toBe("browser");
  });

  it("reports no dictation without a recogniser or user agent", () => {
    expect(dictationMode({ navigator: { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" } })).toBeNull();
    expect(dictationMode({})).toBeNull();
  });
});

describe("speakable text", () => {
  it("drops code and markdown markers but keeps link text", () => {
    const markdown = "## 結果\n\n- 已修好 **登入**\n- 參考 [文件](https://example.com)\n\n```ts\nconst a = 1;\n```\n用 `npm test` 驗證";
    expect(speakableText(markdown)).toBe("結果 已修好 登入 參考 文件 用 npm test 驗證");
  });

  it("truncates long replies", () => {
    expect(speakableText("a".repeat(20), 5)).toBe("aaaaa…");
  });
});
