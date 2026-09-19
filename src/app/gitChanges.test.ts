import { describe, expect, it } from "vitest";
import { diffLineKind, diffQuote, hasUnstagedChange, isStaged } from "./gitChanges";

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
});
