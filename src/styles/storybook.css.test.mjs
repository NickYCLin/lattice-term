import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./storybook.css", import.meta.url), "utf8");
const tokens = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const palette = tokens.match(/\[data-theme="storybook"\]\s*\{([^}]+)\}/s)?.[1] ?? "";
const values = Object.fromEntries([...palette.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
function color(name) {
  const value = values[name];
  expect(value, name).toBeDefined();
  const alias = value.match(/^var\((--[\w-]+)\)$/);
  if (alias) return color(alias[1]);
  expect(value).toMatch(/^#[\da-f]{6}$/i);
  return [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16));
}
function luminance(rgb) {
  return rgb.map(channel => channel / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}
function contrast(a, b) {
  const [low, high] = [luminance(a), luminance(b)].sort((a, b) => a - b);
  return (high + 0.05) / (low + 0.05);
}

describe("storybook cream surfaces", () => {
  it("uses the same cream token for the real rail and its theme preview", () => {
    expect(styles).toMatch(/:root\[data-theme="storybook"\] \.rail\s*\{\s*background:\s*var\(--canvas-deep\);/);
    expect(styles).toMatch(/\.theme-option__preview\[data-theme="storybook"\] \.theme-option__rail\s*\{\s*background:\s*var\(--canvas-deep\);/);
    expect(styles).not.toContain("#e8f2f5");
  });
  it("keeps thread selections and shared large soft fills warm rather than blue", () => {
    expect(styles).toMatch(/\.chat-thread\.is-active\s*\{\s*background:\s*var\(--surface-selected\);/);
    expect(styles).not.toMatch(/background:\s*var\(--storybook-blue\)/);
    for (const token of ["--canvas", "--canvas-deep", "--surface-solid", "--surface-selected", "--accent-soft", "--info-soft"]) {
      const [r, g, b] = color(token);
      expect(r, token).toBeGreaterThanOrEqual(g);
      expect(g, token).toBeGreaterThan(b);
    }
  });
  it("keeps ordinary, muted, faint and accent text at least 4.5:1 on navigation and selection fills", () => {
    for (const foreground of ["--text", "--text-muted", "--text-faint", "--accent"]) {
      for (const background of ["--canvas", "--canvas-deep", "--surface-solid", "--surface-raised", "--surface-selected", "--storybook-yellow", "--accent-soft", "--info-soft"]) {
        expect(contrast(color(foreground), color(background)), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe("storybook select control borders", () => {
  it("targets both native select forms without matching the label wrapper", () => {
    const borderedRules = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, selector, body]) => selector.includes('data-theme="storybook"') && body.includes("border:"));
    const fieldRule = borderedRules.find(([ ,selector]) => selector.includes("select.select"));
    expect(fieldRule).toBeDefined();
    expect(fieldRule[1]).toContain(".select select");
    expect(fieldRule[1]).not.toMatch(/(?:\(|,)\s*\.select\s*(?:,|\))/);
    expect(fieldRule[2]).toContain("border: 2px solid var(--line-strong)");
    for (const [, selector] of borderedRules) {
      expect(selector).not.toMatch(/(?:\(|,)\s*\.select\s*(?:,|\))/);
    }
    expect(styles).toMatch(/\.connections__tools \.select select\s*\{\s*border: 1px solid var\(--control-line\);/);
  });
});
