import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./agents.css", import.meta.url), "utf8");
const narrow = styles.slice(styles.indexOf("@media (max-width: 50rem)"));

describe("agent session permission layout", () => {
  it("moves narrow session metadata and status onto separate full-width rows", () => {
    expect(narrow).toMatch(
      /\.agent-session-row__main,\s*\.agent-session-row__status\s*\{[^}]*grid-column:\s*2 \/ -1;/s,
    );
    expect(narrow).toMatch(
      /\.agent-session-row__status\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;/s,
    );
    expect(narrow).toMatch(
      /\.agent-session-row > \.button\s*\{[^}]*grid-column:\s*2;/s,
    );
    expect(narrow).toMatch(
      /\.agent-session-row > \.icon-button\s*\{[^}]*grid-column:\s*3;/s,
    );
  });

  it("wraps permission labels without shrinking or recoloring the checkbox", () => {
    expect(styles).toMatch(
      /\.agent-session-row__main \.agents-mcp__toggle > span:not\(\.checkbox__box\)\s*\{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/s,
    );
    expect(styles).toMatch(
      /\.agent-session-row__main \.agents-mcp__toggle > \.checkbox__box\s*\{[^}]*flex:\s*0 0 1\.125rem;/s,
    );
    expect(styles).toMatch(/\.agent-session-row__main > span\s*\{/);
    expect(styles).not.toMatch(/\.agent-session-row__main span\s*\{/);
  });

  it("preserves the desktop five-column layout", () => {
    expect(styles).toMatch(
      /\.agent-session-row\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto auto auto;/s,
    );
  });
});
