import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./terminalScrollback.css", import.meta.url), "utf8");

describe("terminal scrollbar styles", () => {
  it("removes the empty native viewport scrollbar without hiding xterm's slider", () => {
    const viewport = css.match(/\.terminal-pane \.xterm \.xterm-viewport\s*\{([^}]+)\}/)?.[1];
    expect(viewport).toContain("overflow: hidden;");
    expect(css).not.toMatch(/scrollbar-width:\s*none/);
    expect(css).not.toMatch(/display:\s*none/);
  });

  it("keeps the custom vertical scrollbar interactive when history exists", () => {
    const scrollbar = css.match(/\.xterm\.has-scrollback \.xterm-scrollable-element > \.xterm-scrollbar\.xterm-vertical\s*\{([^}]+)\}/)?.[1];
    expect(scrollbar).toContain("opacity: 1;");
    expect(scrollbar).toContain("pointer-events: auto;");
  });
});
