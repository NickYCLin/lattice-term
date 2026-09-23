import { describe, expect, it } from "vitest";
import { jevErrorKey, prepareJevPreview, validJevPreview } from "./jevAdvice";

describe("Jev reviewed excerpts", () => {
  it("removes terminal escapes and common identifying fields before review", () => {
    const preview = prepareJevPreview([
      "\x1b[31mAuthentication expired\x1b[0m",
      "\x1b]0;private title\x07",
      "API_KEY=synthetic-credential",
      "user@example.invalid https://service.example.invalid/path",
      "C:\\Users\\fiction\\repo\\file.ts /home/fiction/repo/file.ts 192.0.2.10",
    ].join("\n"));
    expect(preview).toContain("Authentication expired");
    for (const value of ["private title", "synthetic-credential", "user@", "service.example", "fiction", "192.0.2", "\x1b"]) {
      expect(preview).not.toContain(value);
    }
    expect(validJevPreview(preview)).toBe(true);
  });

  it("bounds unicode by encoded bytes and retains only recent lines", () => {
    const preview = prepareJevPreview(Array.from({ length: 80 }, (_, i) => `${i} ${"繁體中文".repeat(100)}`).join("\n"));
    expect(new TextEncoder().encode(preview).length).toBeLessThanOrEqual(8_000);
    expect(preview.split("\n").length).toBeLessThanOrEqual(40);
    expect(preview).toContain("79 ");
    expect(preview).not.toContain("39 ");
    expect(validJevPreview(preview)).toBe(true);
  });

  it("rejects empty, oversized and terminal-control input without exposing raw backend errors", () => {
    for (const text of ["", " \n ", "a\n".repeat(41), "中".repeat(3_000), "\x1b[0m"]) {
      expect(validJevPreview(text)).toBe(false);
    }
    expect(jevErrorKey("jev.error.auth")).toBe("jev.error.auth");
    expect(jevErrorKey("secret server response")).toBe("jev.error.internal");
  });
});
