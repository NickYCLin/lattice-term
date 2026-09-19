import { describe, expect, it } from "vitest";
import { completionNotificationText, looksLikeDiff } from "./agentChat";

describe("reply notification text", () => {
  it("uses the thread title and the start of the last reply", () => {
    const text = completionNotificationText({
      title: "Release plan",
      items: [
        { type: "user", id: "u", text: "hi" },
        { type: "text", id: "a1", text: "old" },
        { type: "text", id: "a2", text: `Done.\n\n${"x".repeat(300)}` },
      ] as never,
    });
    expect(text.title).toBe("Release plan");
    expect(text.body.startsWith("Done. xxx")).toBe(true);
    expect(text.body.length).toBe(180);
  });

  it("still says something for an untitled thread with no text", () => {
    expect(completionNotificationText({ title: "", items: [] })).toEqual({ title: "LatticeTerm", body: "✓" });
  });
});

describe("tool output shape", () => {
  it("colours only real unified diffs", () => {
    expect(looksLikeDiff("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b")).toBe(true);
    expect(looksLikeDiff("update src/a.rs")).toBe(false);
    expect(looksLikeDiff("@@ something @@ without headers")).toBe(false);
    expect(looksLikeDiff(null)).toBe(false);
  });
});

