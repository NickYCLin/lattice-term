import { describe, expect, it } from "vitest";
import { unsweetenPunctuation } from "./plainTextInput";

describe("unsweetenPunctuation", () => {
  it("restores straight quotes and ASCII dashes", () => {
    expect(unsweetenPunctuation("echo ‘hello’")).toBe("echo 'hello'");
    expect(unsweetenPunctuation("echo “hello”")).toBe('echo "hello"');
    expect(unsweetenPunctuation("foo—bar")).toBe("foo--bar");
    expect(unsweetenPunctuation("foo–bar")).toBe("foo-bar");
  });

  it("leaves Chinese full-width punctuation alone", () => {
    expect(unsweetenPunctuation("你好，世界！")).toBe("你好，世界！");
  });

  it("leaves already-plain ASCII unchanged", () => {
    expect(unsweetenPunctuation(`printf '%s' "ok" --flag`)).toBe(
      `printf '%s' "ok" --flag`,
    );
  });
});
