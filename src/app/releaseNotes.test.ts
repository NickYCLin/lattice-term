import { describe, expect, it } from "vitest";
import { parseReleaseNotes } from "./releaseNotes";

const body = [
  "## 🚀 新增功能",
  "",
  "- **files**：支援遠端純文字線上編輯 ([#187](https://github.com/o/r/issues/187)) ([4b7f7e8](https://github.com/o/r/commit/4b7f7e829523bcc1b9bb53e6db158a8b368a18ce)), closes [#186](https://github.com/o/r/issues/186)",
  "- **mcp**：加入操作紀錄並修正升級連線 ([e241587](https://github.com/o/r/commit/e241587d587fbc4ed101f595177e0b0397e7c9cf))",
  "",
  "## 🛠️ 問題修正與優化",
  "",
  "- **ui**：避免側欄蓋住導覽提示",
  "",
  "升級後請重新啟動 `lattice-term`。",
].join("\n");

describe("parseReleaseNotes", () => {
  it("keeps the sentence and drops the Markdown around it", () => {
    const sections = parseReleaseNotes(body);

    expect(sections.map((section) => section.title)).toEqual([
      "🚀 新增功能",
      "🛠️ 問題修正與優化",
    ]);
    expect(sections[0].items).toEqual([
      "files：支援遠端純文字線上編輯 (#187), closes #186",
      "mcp：加入操作紀錄並修正升級連線",
    ]);
    expect(sections[1].items).toEqual(["ui：避免側欄蓋住導覽提示"]);
    // Text outside a list is kept, with its code markers removed.
    expect(sections[1].paragraphs).toEqual(["升級後請重新啟動 lattice-term。"]);
  });

  it("handles notes with no headings, empty notes and stray markup", () => {
    expect(parseReleaseNotes(null)).toEqual([]);
    expect(parseReleaseNotes("   \n\n")).toEqual([]);
    expect(parseReleaseNotes("## 只有標題")).toEqual([]);

    const sections = parseReleaseNotes(
      ["修正幾個問題。", "---", "* 第一項", "1. 第二項", "***重要***"].join("\n"),
    );
    expect(sections).toHaveLength(1);
    expect(sections[0].title).toBeNull();
    expect(sections[0].items).toEqual(["第一項", "第二項"]);
    expect(sections[0].paragraphs).toEqual(["修正幾個問題。", "重要"]);
  });

  it("leaves a link that is not a commit reference readable", () => {
    const sections = parseReleaseNotes(
      "- 詳見 [升級說明](https://example.com/upgrade) 與 [abc1234](https://example.com/notes)",
    );
    expect(sections[0].items).toEqual(["詳見 升級說明 與 abc1234"]);
  });
});
