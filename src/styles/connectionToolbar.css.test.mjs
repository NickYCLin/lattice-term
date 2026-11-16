import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const controls = readFileSync(new URL("./controls.css", import.meta.url), "utf8");
const styles = readFileSync(new URL("./connections.css", import.meta.url), "utf8");

it("shares height, surface, border and radius across sorting and adjacent tools", () => {
  expect(styles).toMatch(/\.connections__tools\s*\{[^}]*--connection-tool-height: var\(--control-compact-height\);/s);
  const rule = styles.match(/\.connections__tools :is\(\.button, \.select select, \.connection-kind-filter\)\s*\{([^}]+)\}/s)?.[1];
  expect(rule).toBeDefined();
  for (const declaration of ["height: var(--connection-tool-height)", "border: 1px solid var(--control-line)",
    "border-radius: var(--radius-pill)", "background-color: var(--surface-raised)"]) expect(rule).toContain(declaration);
  expect(styles).toMatch(/\.connections__tools \.connection-kind-filter button\s*\{[^}]*min-height: 0;[^}]*height: 100%;/s);
});
it("uses a shared visible focus ring and retains mobile touch targets", () => {
  expect(controls).toContain("outline: var(--control-focus-width) solid var(--control-focus-color, var(--focus))");
  expect(styles).toMatch(/\.app--mobile \.connections__tools\s*\{[^}]*--connection-tool-height: max\(2\.75rem,/s);
});
