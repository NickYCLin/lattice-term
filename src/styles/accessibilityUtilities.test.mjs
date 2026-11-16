import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, it } from "vitest";
const root = fileURLToPath(new URL("..", import.meta.url));
function files(directory) { return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]); }
it("defines every screen-reader utility class referenced by JSX", () => {
  const all = files(root), css = all.filter(file => file.endsWith(".css")).map(file => readFileSync(file, "utf8")).join("\n");
  for (const file of all.filter(file => file.endsWith(".tsx") && !file.includes(".test."))) {
    const source = readFileSync(file, "utf8");
    for (const utility of ["sr-only", "visually-hidden"]) {
      if (new RegExp(`className=["'\\x60][^"'\\x60]*\\b${utility}\\b`).test(source)) expect(css, `${file}: ${utility}`).toMatch(new RegExp(`\\.${utility}\\s*[{,]`));
    }
  }
});
it("visually hides the jump route label while preserving its accessible select name", () => {
  const source = readFileSync(join(root, "components/connections/ConnectionCard.tsx"), "utf8");
  expect(source).toContain('<span className="visually-hidden">{t("jump.route")}</span>');
  expect(source).not.toContain('className="sr-only"');
  expect(source).toContain('aria-label={t("jump.route")}');
});
