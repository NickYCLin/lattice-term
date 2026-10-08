import { describe, expect, it, vi } from "vitest";
import {
  LINUX_TERMINAL_FONT_FAMILIES,
  TERMINAL_FONT_FAMILIES,
  TERMINAL_FONT_FAMILY,
  TERMINAL_LETTER_SPACING,
  terminalFontFamily,
  terminalTheme,
} from "./terminalTheme";

describe("terminal font family", () => {
  it("gives the scrollbar a visible idle, hover and dragging colour", () => {
    vi.stubGlobal("document", { documentElement: {} });
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
    try {
      const theme = terminalTheme();
      expect(theme.scrollbarSliderBackground).toBe("#6e7681");
      expect(theme.scrollbarSliderHoverBackground).toBe("#8b949e");
      expect(theme.scrollbarSliderActiveBackground).toBe("#b1bac4");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses concrete Linux monospace families before the generic fallback", () => {
    expect(TERMINAL_FONT_FAMILIES).toContain('"Noto Sans Mono"');
    expect(TERMINAL_FONT_FAMILIES).toContain('"DejaVu Sans Mono"');
    expect(TERMINAL_FONT_FAMILIES[TERMINAL_FONT_FAMILIES.length - 1]).toBe(
      "monospace",
    );
    expect(TERMINAL_FONT_FAMILY).not.toContain("ui-monospace");
  });

  it("tightens xterm cells so normal text does not resemble spaced input", () => {
    expect(TERMINAL_LETTER_SPACING).toBe(-1);
  });

  it("puts an installed monospace family first on Linux desktop", () => {
    const family = terminalFontFamily(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15",
    );

    expect(family).toBe(LINUX_TERMINAL_FONT_FAMILIES.join(", "));
    expect(LINUX_TERMINAL_FONT_FAMILIES[0]).toBe('"Noto Sans Mono"');
  });

  it("keeps the cross-platform font chain outside Linux desktop", () => {
    expect(terminalFontFamily("Mozilla/5.0 (Windows NT 10.0)")).toBe(
      TERMINAL_FONT_FAMILY,
    );
    expect(terminalFontFamily("Mozilla/5.0 (Linux; Android 16)")).toBe(
      TERMINAL_FONT_FAMILY,
    );
  });
});
