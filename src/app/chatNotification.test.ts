import { describe, expect, it } from "vitest";
import { completionNotificationText } from "./agentChat";

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
