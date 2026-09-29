import { describe, expect, it } from "vitest";
import { mentionsInPrompt, type ChatMention } from "../../app/agentChat";
import { restoreQueuedInputs } from "../../app/chatInputQueue";
import { skillMention, skillPick, skillSourceLabel } from "./ChatSkillPicker";

describe("skill mentions", () => {
  it("uses Codex's own mention and plain words elsewhere", () => {
    expect(skillMention("codex", "release notes")).toBe("$release-notes ");
    expect(skillMention("claude", "pdf")).toBe("Use the `pdf` skill. ");
    expect(skillMention("gemini", "a`b\nc")).toBe("Use the `abc` skill. ");
  });

  it("shows the backend's fixed source words in the interface language", () => {
    const t = (key: string) => `[${key}]`;
    expect(skillSourceLabel("外掛", t)).toBe("[chat.skills.source.plugin]");
    expect(skillSourceLabel("帳號", t)).toBe("[chat.skills.source.account]");
    expect(skillSourceLabel("Custom", t)).toBe("Custom");
  });

  it("turns Codex catalogue entries into structured picks only for Codex", () => {
    const plugin = { name: "GitHub", description: null, source: "外掛", kind: "plugin" as const,
      path: "plugin://github@openai-curated", token: "@github" };
    expect(skillPick("codex", plugin)).toEqual({ kind: "plugin", name: "GitHub",
      path: "plugin://github@openai-curated", token: "@github" });
    expect(skillPick("claude", plugin)).toBeNull();
    expect(skillPick("codex", { name: "old", description: null, source: "帳號" })).toBeNull();
  });

  it("sends only the picks whose token is still in the message", () => {
    const pdf: ChatMention = { kind: "skill", name: "pdf:pdf", path: "/s/pdf/SKILL.md", token: "$pdf:pdf" };
    const github: ChatMention = { kind: "plugin", name: "GitHub", path: "plugin://github@c", token: "@github" };
    expect(mentionsInPrompt("用 $pdf:pdf 讀這份，再 @github 開 issue", [pdf, github, pdf])).toEqual([pdf, github]);
    expect(mentionsInPrompt("只用 $pdf:pdfx", [pdf, github])).toEqual([]);
  });

  it("keeps picks on queued messages across a restart and drops malformed ones", () => {
    const base = { id: "q1", prompt: "$pdf 看一下", attachments: [], profileConfigPath: null, createdAt: 1 };
    const pick = { kind: "skill", name: "pdf", path: "/s/pdf/SKILL.md", token: "$pdf" };
    expect(restoreQueuedInputs([{ ...base, mentions: [pick] }])[0].mentions).toEqual([pick]);
    expect(restoreQueuedInputs([base])[0].mentions).toBeUndefined();
    expect(restoreQueuedInputs([{ ...base, mentions: [{ ...pick, kind: "file" }] }])).toEqual([]);
  });
});
