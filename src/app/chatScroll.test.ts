import { describe, expect, it } from "vitest";
import { isChatAtBottom } from "./chatScroll";

describe("chat follow position", () => {
  it.each([24, 48, 120])("stops following after scrolling up %i pixels", gap => {
    expect(isChatAtBottom({ scrollHeight: 2000, clientHeight: 600, scrollTop: 1400 - gap })).toBe(false);
  });

  it.each([1400, 1399.5, 1400.5])("follows at the bottom despite fractional rounding: %s", scrollTop => {
    expect(isChatAtBottom({ scrollHeight: 2000, clientHeight: 600, scrollTop })).toBe(true);
  });

  it("follows when content does not overflow", () => {
    expect(isChatAtBottom({ scrollHeight: 600, clientHeight: 600, scrollTop: 0 })).toBe(true);
  });
});
