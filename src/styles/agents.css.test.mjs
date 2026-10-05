import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./agents.css", import.meta.url), "utf8");
const narrow = styles.slice(styles.indexOf("@media (max-width: 50rem)"));

describe("running agent list layout", () => {
  it("keeps each agent on one line with its actions on the right", () => {
    expect(styles).toMatch(
      /\.agent-session-row\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto;/s,
    );
    expect(styles).toMatch(/\.agent-session-row \+ \.agent-session-row\s*\{[^}]*border-top:/s);
    expect(styles).toMatch(/\.agent-session-row__actions\s*\{[^}]*display:\s*flex;/s);
  });

  it("truncates a long folder instead of pushing the actions away", () => {
    expect(styles).toMatch(
      /\.agent-session-row__meta > \.agent-session-row__path\s*\{[^}]*min-width:\s*0;[^}]*text-overflow:\s*ellipsis;/s,
    );
  });

  it("keeps row selects compact rather than full form fields", () => {
    expect(styles).toMatch(
      /\.agent-session-row__actions select\.select,\s*\.agents-pacing__limit select\.select\s*\{[^}]*width:\s*auto;[^}]*height:\s*1\.75rem;/s,
    );
  });

  it("moves the actions under the name on narrow windows", () => {
    expect(narrow).toMatch(
      /\.agent-session-row__actions\s*\{[^}]*grid-column:\s*2 \/ -1;[^}]*flex-wrap:\s*wrap;/s,
    );
  });
});
