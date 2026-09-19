import { describe, expect, it } from "vitest";
import { skillMention } from "./ChatSkillPicker";

describe("skill mentions", () => {
  it("uses Codex's own mention and plain words elsewhere", () => {
    expect(skillMention("codex", "release notes")).toBe("$release-notes ");
    expect(skillMention("claude", "pdf")).toBe("Use the `pdf` skill. ");
    expect(skillMention("gemini", "a`b\nc")).toBe("Use the `abc` skill. ");
  });
});
