/**
 * The terminal content area always renders on a dark background, regardless of
 * the app's light/dark theme.
 *
 * CLI tools (gemini, claude, ssh sessions, TUIs) overwhelmingly assume a dark
 * terminal and paint light text, so a light background left them washed out to
 * the point of being unreadable. Pinning a dark, well-tuned ANSI palette here —
 * while the rest of the app still follows the chosen theme — makes their output
 * look the way they intend. The Terminal's minimumContrastRatio stays on as a
 * safety net for any colour a CLI still picks poorly against this background.
 *
 * Only the cursor tracks the app accent, so the terminal keeps a hint of the
 * active theme without risking a low-contrast surface.
 */
export const TERMINAL_FONT_FAMILIES = [
  '"JetBrains Mono"',
  '"Cascadia Mono"',
  '"SF Mono"',
  '"SFMono-Regular"',
  '"Noto Sans Mono"',
  '"DejaVu Sans Mono"',
  '"Liberation Mono"',
  '"Ubuntu Mono"',
  "Consolas",
  "monospace",
] as const;

export const LINUX_TERMINAL_FONT_FAMILIES = [
  '"Noto Sans Mono"',
  '"DejaVu Sans Mono"',
  '"Liberation Mono"',
  '"Ubuntu Mono"',
  "monospace",
] as const;

/**
 * WebKitGTK can resolve the CSS `ui-monospace` generic to proportional Noto
 * Sans. xterm still allocates fixed cells in that case, which makes every
 * glyph look as though a space was inserted after it. Concrete cross-platform
 * monospace families keep the measured cell width and rendered glyph aligned.
 */
export const TERMINAL_FONT_FAMILY = TERMINAL_FONT_FAMILIES.join(", ");

/**
 * Fontconfig may substitute the first unavailable family instead of trying the
 * rest of a CSS list. The bundled Linux desktop therefore needs an installed
 * monospace family first; otherwise xterm measures fixed cells around a
 * proportional Noto Sans fallback and every character looks space-separated.
 */
export function terminalFontFamily(
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
): string {
  if (/\bLinux\b/i.test(userAgent) && !/\bAndroid\b/i.test(userAgent)) {
    return LINUX_TERMINAL_FONT_FAMILIES.join(", ");
  }
  return TERMINAL_FONT_FAMILY;
}

/**
 * xterm must keep a fixed grid, but WebKitGTK leaves enough side bearing at
 * the default spacing for ordinary text to look as though spaces were typed
 * between characters. Tighten each cell by one pixel without changing the
 * PTY text or sacrificing terminal alignment.
 */
export const TERMINAL_LETTER_SPACING = -1;

export function terminalTheme(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const accent = style.getPropertyValue("--accent").trim() || "#58a6ff";

  const background = "#181d26";
  const foreground = "#e6edf3";

  return {
    background,
    foreground,
    cursor: accent,
    cursorAccent: background,
    selectionBackground: "rgba(88, 166, 255, 0.30)",
    scrollbarSliderBackground: "#6e7681",
    scrollbarSliderHoverBackground: "#8b949e",
    scrollbarSliderActiveBackground: "#b1bac4",
    // A GitHub-dark-style palette: every colour is tuned to stay legible on the
    // dark background above, including a black that never collapses into it.
    black: "#484f58",
    red: "#ff7b72",
    green: "#3fb950",
    yellow: "#d29922",
    blue: "#58a6ff",
    magenta: "#bc8cff",
    cyan: "#39c5cf",
    white: "#b1bac4",
    brightBlack: "#6e7681",
    brightRed: "#ffa198",
    brightGreen: "#56d364",
    brightYellow: "#e3b341",
    brightBlue: "#79c0ff",
    brightMagenta: "#d2a8ff",
    brightCyan: "#56d4dd",
    brightWhite: "#f0f6fc",
  };
}
