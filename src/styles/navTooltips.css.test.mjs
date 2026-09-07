import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const baseStyles = readFileSync(new URL("./base.css", import.meta.url), "utf8");
const shellStyles = readFileSync(new URL("./shell.css", import.meta.url), "utf8");
const overlayStyles = readFileSync(new URL("./overlays.css", import.meta.url), "utf8");

describe("navigation tooltip layers", () => {
  it("isolates glass panels without relying on a supported backdrop filter", () => {
    expect(baseStyles).toMatch(/\.glass\s*\{[^}]*isolation:\s*isolate;/s);
  });

  it("keeps the rail above panel content but below modal scrims", () => {
    const railLayer = Number(shellStyles.match(/\.rail\s*\{[^}]*z-index:\s*(\d+);/s)?.[1]);
    const modalLayer = Number(overlayStyles.match(/\.scrim\s*\{[^}]*z-index:\s*(\d+);/s)?.[1]);
    expect(railLayer).toBeGreaterThan(0);
    expect(railLayer).toBeLessThan(modalLayer);
  });

  it("supports keyboard focus and does not intercept pointer input", () => {
    expect(shellStyles).toMatch(/\[data-tooltip\]:focus-visible::after\s*\{[^}]*opacity:\s*1;/s);
    expect(shellStyles).toMatch(/\[data-tooltip\]::after\s*\{[^}]*pointer-events:\s*none;/s);
    expect(shellStyles).toMatch(/\.app--mobile \.rail \[data-tooltip\]::after,[^{]*\{[^}]*display:\s*none;/s);
  });
});
