import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const connectionStyles = readFileSync(
  new URL("./connections.css", import.meta.url),
  "utf8",
);
const shellStyles = readFileSync(new URL("./shell.css", import.meta.url), "utf8");
const mobileStyles = readFileSync(new URL("./mobile.css", import.meta.url), "utf8");
const overlayStyles = readFileSync(
  new URL("./overlays.css", import.meta.url),
  "utf8",
);

describe("mobile connection layout", () => {
  it("uses a shrinkable single-column grid without desktop gutters", () => {
    expect(connectionStyles).toMatch(
      /\.app--mobile \.connection-grid,[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/,
    );
    expect(connectionStyles).toMatch(
      /\.app--mobile \.connections__scroll\s*\{[^}]*padding:\s*0 0 var\(--space-6\);/s,
    );
  });

  it("lets narrow header and toolbar actions wrap instead of overflowing", () => {
    expect(connectionStyles).toMatch(
      /\.app--mobile \.connections__toolbar\s*\{[^}]*flex-wrap:\s*wrap;/s,
    );
    expect(connectionStyles).toMatch(
      /\.app--mobile \.connections__tools\s*\{[^}]*width:\s*100%;[^}]*flex-wrap:\s*wrap;/s,
    );
    expect(shellStyles).toMatch(
      /\.app--mobile \.view-header__actions\s*\{[^}]*width:\s*100%;[^}]*flex-wrap:\s*wrap;/s,
    );
  });

  it("keeps the advanced drawer section visible inside a short viewport", () => {
    expect(overlayStyles).toMatch(
      /\.connection-advanced\s*\{[^}]*flex:\s*none;/s,
    );
  });

  it("preserves a full title row after the late mobile overrides load", () => {
    expect(mobileStyles).toMatch(
      /@media \(max-width: 42rem\)\s*\{\s*\.app--mobile \.view-header__text\s*\{\s*flex: 1 1 0;/,
    );
    expect(mobileStyles).toMatch(
      /@media \(max-width: 42rem\)[\s\S]*?\.app--mobile \.view-header__actions\s*\{[^}]*width: 100%;[^}]*flex-basis: 100%;[^}]*margin-left: 0;/,
    );
  });

  it("turns the hidden mobile resource sidebar into a safe-area drawer", () => {
    expect(shellStyles).toMatch(
      /\.app--mobile \.sidebar\s*\{[^}]*display:\s*none;/s,
    );
    expect(shellStyles).toMatch(
      /\.app--mobile \.resource-sidebar-scrim \.sidebar\s*\{[^}]*display:\s*flex;[^}]*width:\s*min\(20rem, 88vw\);[^}]*height:\s*100%;/s,
    );
    expect(shellStyles).toMatch(
      /\.app--mobile \.resource-sidebar-scrim\s*\{[^}]*justify-content:\s*flex-start;/s,
    );
    expect(shellStyles).toMatch(
      /\.app--mobile \.resource-sidebar-scrim \.sidebar\s*\{[^}]*safe-area-inset-top[^}]*safe-area-inset-bottom/s,
    );
  });
});
