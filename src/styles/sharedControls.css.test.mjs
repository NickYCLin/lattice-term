import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const read = name => readFileSync(new URL(`./${name}.css`, import.meta.url), "utf8");
const controls = read("controls"), tokens = read("tokens"), database = read("database"), chat = read("chat");

it("gives bare selects, input-class selects and standard fields a token-based skin", () => {
  const field = controls.match(/:is\(\.input, \.textarea, select\)\s*\{([^}]+)\}/s)?.[1];
  for (const value of ["height: var(--control-field-height)", "border: var(--control-field-border-width) solid var(--control-field-line)",
    "border-radius: var(--control-field-radius)", "background-color: var(--control-field-surface)"]) expect(field).toContain(value);
  expect(controls).toContain(".select:not(select)");
  expect(controls).toContain("select:not([multiple])");
  expect(controls).toContain("height: var(--control-compact-height)");
  expect(tokens).toMatch(/\[data-theme="storybook"\]\s*\{\s*--control-field-border-width: 2px;/);
});
it("shares keyboard focus and disabled fieldset states without hiding errors", () => {
  expect(controls).toContain(':is(button, [role="button"], [role="radio"], a.button, input, select, textarea):focus-visible');
  expect(controls).toContain("outline: var(--control-focus-width) solid var(--control-focus-color, var(--focus))");
  expect(controls).toContain(':is(:disabled, [aria-disabled="true"])');
  expect(controls).toContain("opacity: var(--control-disabled-opacity)");
  expect(controls).toContain("--control-focus-color: var(--danger)");
  expect(read("control-contrast")).not.toContain("box-shadow: 0 0 0 3px var(--canvas-deep)");
});
it("keeps native choice semantics and the hidden custom-checkbox input", () => {
  expect(controls).toMatch(/input:where\(\[type="checkbox"\], \[type="radio"\]\)\s*\{[^}]*width: var\(--control-choice-size\);/s);
  expect(controls).toContain('input:where([type="checkbox"], [type="radio"], [type="range"]) { accent-color: var(--accent); }');
  expect(controls).toMatch(/\.checkbox input\s*\{[^}]*opacity: 0;[^}]*width: 0;/s);
  expect(controls).toContain(".checkbox input:disabled + .checkbox__box { opacity: var(--control-disabled-opacity); }");
  expect(controls).toContain("border-radius: var(--control-choice-radius)");
});
it("removes duplicate select skins and preserves the inline composer variant", () => {
  expect(read("connections")).toMatch(/\.sound-event select \{ width: 100%; min-width: 0; \}/);
  expect(database).not.toContain(".database-manager__fields select { appearance:");
  expect(database).not.toContain("min-height: 2.875rem");
  expect(chat).toMatch(/\.session-composer__access--editable select\s*\{[^}]*width: auto;[^}]*height: auto;[^}]*border: 0;/s);
  expect(chat).toContain(".session-composer__access--editable select:focus-visible { outline: none; box-shadow: none; }");
  expect(read("mobile")).toContain("--control-field-height: max(2.75rem");
});
