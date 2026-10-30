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
  it("lets the empty connections page scroll to actions in landscape", () => {
    expect(mobileStyles).toMatch(/\.app--mobile \.connections--empty\s*\{[^}]*overflow-y:\s*auto;/s);
    expect(mobileStyles).toMatch(/\.app--mobile \.connections--empty > \.empty-state\s*\{[^}]*flex:\s*1 0 auto;/s);
  });
  it("compacts short landscape empty states without shrinking action targets", () => {
    expect(mobileStyles).toMatch(/@media \(orientation: landscape\) and \(max-height: 30rem\)\s*\{\s*\.app--mobile \.connections--empty > \.empty-state\s*\{\s*gap: var\(--space-1\);\s*padding: var\(--space-2\);/);
    expect(mobileStyles).toMatch(/\.app--mobile \.connections--empty \.empty-state__icon\s*\{ display: none; \}/);
    expect(mobileStyles).toMatch(/\.app--mobile \.connections--empty \.empty-state__text\s*\{ max-width: none; \}/);
    expect(mobileStyles).toContain(".app--mobile .button { min-height: 2.75rem; }");
  });
  it("separates card details, connection routes and management without shrinking touch targets", () => {
    expect(connectionStyles).toMatch(
      /\.connection-card\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);[^}]*grid-template-areas:\s*"head" "meta" "primary" "foot";/s,
    );
    expect(connectionStyles).toMatch(
      /\.connection-card__foot\s*\{[^}]*flex-wrap:\s*wrap;/s,
    );
    expect(mobileStyles).toMatch(
      /\.app--mobile \.icon-button--sm\s*\{[^}]*min-width:\s*2\.75rem;[^}]*min-height:\s*2\.75rem;/s,
    );
  });

  it("allows routes and metadata to wrap without squeezing the host heading", () => {
    expect(connectionStyles).toMatch(/\.connection-card__actions\s*\{[^}]*flex-wrap:\s*wrap;[^}]*max-width:\s*100%;/s);
    expect(connectionStyles).toMatch(/\.connection-card__meta\s*\{[^}]*flex-wrap:\s*wrap;/s);
    expect(connectionStyles).toMatch(/\.connection-route-picker__list\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/s);
    expect(connectionStyles).toMatch(/\.connection-card__target\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
    expect(connectionStyles).not.toMatch(/\.connection-card__primary\s*\{[^}]*max-width:/s);
  });

  it("gives route content natural height and keeps its target shrinkable", () => {
    expect(connectionStyles).toMatch(/\.connection-card__route\s*\{[^}]*height:\s*auto;[^}]*min-height:\s*3\.5rem;/s);
    expect(connectionStyles).toMatch(/\.connection-card__route-info\s*\{[^}]*min-width:\s*0;/s);
    expect(connectionStyles).toMatch(/\.connection-card__route-target\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
  });

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
      /\.connections__tools\s*\{[^}]*flex-wrap:\s*wrap;[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/s,
    );
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
