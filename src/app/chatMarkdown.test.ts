import { describe, expect, it } from "vitest";
import { markdownLinkKind, stripAgentMetadata } from "./chatMarkdown";

describe("stripAgentMetadata", () => {
  const citation = "<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1-2|note=[x]\n</citation_entries>\n<rollout_ids>\n</rollout_ids>\n</oai-mem-citation>";

  it("removes a trailing Codex memory citation", () => {
    expect(stripAgentMetadata(`已推到主線。\n\n${citation}`)).toBe("已推到主線。");
  });

  it("hides a citation that is still streaming in", () => {
    expect(stripAgentMetadata("完成。\n<oai-mem-citation>\n<citation_entries>\nMEM")).toBe("完成。");
  });

  it("keeps the tag inside fenced code and in running text", () => {
    const fenced = `格式如下：\n\`\`\`xml\n${citation}\n\`\`\``;
    expect(stripAgentMetadata(fenced)).toBe(fenced);
    expect(stripAgentMetadata("請在回覆中寫 <oai-mem-citation> 區塊")).toBe("請在回覆中寫 <oai-mem-citation> 區塊");
  });

  it("leaves ordinary replies unchanged", () => {
    expect(stripAgentMetadata("沒有標籤的回覆\n")).toBe("沒有標籤的回覆\n");
  });
});

describe("Markdown link targets", () => {
  it.each(["javascript:alert(1)", "data:text/html,x", "vbscript:x", "file:///etc/passwd", "https://", "//tracker.example/a", "https://example.com/\nattack"])("rejects unsafe target %s", target => {
    expect(markdownLinkKind(target)).toBeNull();
  });
  it.each(["https://example.com/path", "http://localhost:3000/", "mailto:dev@example.com"])("recognizes deliberate external link %s", target => {
    expect(markdownLinkKind(target)).toBe("external");
  });
  it.each(["/work/src/app.ts:12", "src/app.ts", "D:/work/app.ts"])("routes file references through the scoped handler: %s", target => {
    expect(markdownLinkKind(target)).toBe("file");
  });
});
