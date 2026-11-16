import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const overlays = readFileSync(new URL("./overlays.css", import.meta.url), "utf8");
const database = readFileSync(new URL("./database.css", import.meta.url), "utf8");
const mobile = readFileSync(new URL("./mobile.css", import.meta.url), "utf8");

it("centers the connection modal without changing the generic side drawer", () => {
  expect(overlays).toMatch(/\.scrim--center\s*\{[^}]*align-items: center;[^}]*justify-content: center;/s);
  expect(overlays).toMatch(/\.drawer\.connection-modal\s*\{[^}]*width: min\(960px, 90vw\);[^}]*height: 85vh;[^}]*height: 85dvh;[^}]*max-height: 100%;[^}]*margin: 0;[^}]*animation: rise-in/s);
  expect(overlays).toMatch(/\.drawer\s*\{[^}]*animation: slide-in/s);
});
it("keeps the title and actions outside the body scroll region", () => {
  expect(overlays).toMatch(/\.connection-modal > \.drawer__head,\s*\.connection-modal > \.drawer__foot\s*\{[^}]*flex: none;/s);
  expect(overlays).toMatch(/\.connection-modal > \.drawer__body\s*\{[^}]*min-height: 0;[^}]*overflow-y: auto;/s);
  expect(overlays).toMatch(/\.connection-modal > \.drawer__foot,\s*\.connection-modal \.drawer__foot-actions\s*\{[^}]*flex-wrap: wrap;/s);
});
it("uses the available mobile viewport and prevents database width overrides", () => {
  expect(mobile).toMatch(/\.app--mobile \.drawer\.connection-modal\s*\{[^}]*width: 100%;[^}]*height: 100%;[^}]*max-height: 100%;/s);
  expect(mobile).toContain("height: var(--app-viewport-height, 100dvh)");
  expect(mobile).toContain("safe-area-inset-bottom");
  expect(database).not.toMatch(/\.drawer\.drawer--connection-database\s*\{[^}]*width:/s);
});
