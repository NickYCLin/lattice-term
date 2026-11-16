import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const css = readFileSync(new URL("./connections.css", import.meta.url), "utf8");
const database = readFileSync(new URL("./database.css", import.meta.url), "utf8");
const storybook = readFileSync(new URL("./storybook.css", import.meta.url), "utf8");
function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, "g"))].map(match => match[1]).join("\n");
}
it("stretches each grid row and keeps a flexible description above fixed actions and footer", () => {
  expect(rule(".connection-grid")).toContain("align-items: stretch");
  expect(rule(".connection-card")).toContain('grid-template-areas: "head" "meta" "description" "primary" "footer"');
  expect(rule(".connection-card")).toContain("grid-template-rows: auto auto 1fr auto calc(var(--text-xs) * 1.5)");
  expect(rule(".connection-card__footer")).toContain("height: calc(var(--text-xs) * 1.5)");
});
it("reserves two stable button columns and the same rightmost favorite column", () => {
  expect(rule(".connection-card__primary")).toContain("grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) var(--connection-card-action-height)");
  expect(rule(".connection-card__primary")).toContain("border-top: 1px solid var(--line)");
  expect(rule(".connection-card__primary > .connection-card__favorite")).toContain("grid-column: 3");
  expect(css).toContain("max-height: var(--connection-card-action-height)");
  expect(database).not.toMatch(/\.connection-card--database \.connection-card__primary/);
});
it("keeps long names and targets on one ellipsized line across themes", () => {
  for (const selector of [".connection-card__name", ".connection-card__target"]) {
    expect(rule(selector)).toContain("white-space: nowrap");
    expect(rule(selector)).toContain("text-overflow: ellipsis");
  }
  expect(storybook).not.toMatch(/\.connection-card__(primary|footer)[^{]*\{/);
});
it("uses shared theme tokens for session-tree insert lines and the order menu", () => {
  const insertion = rule(".session-tree :is(.is-drop-before, .is-drop-after)::after");
  expect(insertion).toContain("background: var(--accent)");
  expect(insertion).toContain("var(--accent-soft)");
  expect(rule(".session-tree .is-drop-before::after")).toContain("top: -1px");
  expect(rule(".session-tree .is-drop-after::after")).toContain("bottom: -1px");
  expect(rule(".session-tree__order-menu")).toContain("position: fixed");
  expect(rule(".session-tree__order-menu")).toContain("background: var(--surface-solid)");
});
