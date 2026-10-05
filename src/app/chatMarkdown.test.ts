import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, stripAgentMetadata } from "./chatMarkdown";

describe("parseInline", () => {
  it("reads code spans and bold", () => {
    expect(parseInline("run `npm test` **now**")).toEqual([
      { type: "text", text: "run " },
      { type: "code", text: "npm test" },
      { type: "text", text: " " },
      { type: "strong", children: [{ type: "text", text: "now" }] },
    ]);
  });

  it("keeps an unclosed marker as plain text", () => {
    expect(parseInline("a ` b ** c")).toEqual([
      { type: "text", text: "a ` b ** c" },
    ]);
  });

  it("lets a double backtick span contain a single backtick", () => {
    expect(parseInline("``a ` b``")).toEqual([{ type: "code", text: "a ` b" }]);
  });
});

describe("parseMarkdown", () => {
  it("splits paragraphs, headings, lists and fenced code", () => {
    const blocks = parseMarkdown(
      [
        "## 結論",
        "第一段",
        "接續同一段",
        "",
        "- 一",
        "- 二",
        "1. 甲",
        "2. 乙",
        "",
        "```ts",
        "const a = 1;",
        "```",
      ].join("\n"),
    );

    expect(blocks).toEqual([
      { type: "heading", level: 2, children: [{ type: "text", text: "結論" }] },
      {
        type: "paragraph",
        children: [{ type: "text", text: "第一段 接續同一段" }],
      },
      {
        type: "list",
        ordered: false,
        items: [[{ type: "text", text: "一" }], [{ type: "text", text: "二" }]],
      },
      {
        type: "list",
        ordered: true,
        items: [[{ type: "text", text: "甲" }], [{ type: "text", text: "乙" }]],
      },
      { type: "code", language: "ts", text: "const a = 1;" },
    ]);
  });

  it("treats an unterminated fence as code to the end", () => {
    const blocks = parseMarkdown("```\nstill code\nmore");
    expect(blocks).toEqual([{ type: "code", language: "", text: "still code\nmore" }]);
  });

  it("never produces markup from angle brackets", () => {
    const blocks = parseMarkdown("<script>alert(1)</script>");
    expect(blocks).toEqual([
      {
        type: "paragraph",
        children: [{ type: "text", text: "<script>alert(1)</script>" }],
      },
    ]);
  });

  it("keeps indented lines with the list item above", () => {
    const blocks = parseMarkdown("- item\n  continued");
    expect(blocks).toEqual([
      {
        type: "list",
        ordered: false,
        items: [[{ type: "text", text: "item continued" }]],
      },
    ]);
  });
});

describe("stripAgentMetadata", () => {
  const citation = "<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1-2|note=[x]\n</citation_entries>\n<rollout_ids>\n</rollout_ids>\n</oai-mem-citation>";

  it("removes a trailing Codex memory citation", () => {
    expect(stripAgentMetadata(`已推到主線。\n\n${citation}`)).toBe("已推到主線。");
    expect(parseMarkdown(`已推到主線。\n\n${citation}`)).toEqual([
      { type: "paragraph", children: [{ type: "text", text: "已推到主線。" }] },
    ]);
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
