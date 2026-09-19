import { describe, expect, it } from "vitest";
import { commentsMessage, diffLineKind, diffQuote, hasUnstagedChange, isStaged, nearestHunk } from "./gitChanges";

describe("git changes", () => {
  it("sorts files onto the staged and unstaged sides", () => {
    const untracked = { path: "a", staged: "?", unstaged: "?", originalPath: null };
    const both = { path: "b", staged: "M", unstaged: "M", originalPath: null };
    const indexOnly = { path: "c", staged: "A", unstaged: "", originalPath: null };
    expect([untracked, both, indexOnly].filter(isStaged).map((f) => f.path)).toEqual(["b", "c"]);
    expect([untracked, both, indexOnly].filter(hasUnstagedChange).map((f) => f.path)).toEqual(["a", "b"]);
  });

  it("colours diff lines by their role", () => {
    expect(diffLineKind("@@ -1 +1 @@")).toBe("hunk");
    expect(diffLineKind("+++ b/x")).toBe("meta");
    expect(diffLineKind("+added")).toBe("add");
    expect(diffLineKind("-gone")).toBe("remove");
    expect(diffLineKind(" same")).toBe("context");
  });

  it("quotes a diff without letting it close the code fence", () => {
    const quote = diffQuote("x.md", "+```js\n+code", 1000);
    expect(quote.startsWith("`x.md`:")).toBe(true);
    expect(quote.match(/```/g)?.length).toBe(2);
    expect(diffQuote("y", "a".repeat(50), 10)).toContain("…");
  });

  it("gathers line comments into one message, grouped by file", () => {
    const lines = ["diff --git a/x b/x", "@@ -1,2 +1,3 @@", " keep", "+added"];
    expect(nearestHunk(lines, 3)).toBe("@@ -1,2 +1,3 @@");
    expect(nearestHunk(lines, 0)).toBe("");
    const message = commentsMessage([
      { path: "x.ts", hunk: "@@ -1 +1 @@", line: "+added", text: "Rename this" },
      { path: "y.ts", hunk: "", line: "-gone", text: "Why removed?" },
      { path: "x.ts", hunk: "@@ -1 +1 @@", line: " keep", text: " Add a test " },
    ]);
    expect(message.indexOf("`x.ts`")).toBeLessThan(message.indexOf("`y.ts`"));
    expect(message.match(/`x.ts`/g)?.length).toBe(1);
    expect(message).toContain("> +added\n\nRename this");
    expect(message).toContain("Add a test");
    expect(message).toContain("---");
  });
});
