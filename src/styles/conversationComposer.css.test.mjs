import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./chat.css", import.meta.url), "utf8");
function rule(selector) {
  const start = styles.indexOf(selector + " {");
  expect(start).toBeGreaterThanOrEqual(0);
  return styles.slice(start).split("}")[0];
}

describe("conversation composer layout", () => {
  it("aligns delivery notices with the shared composer and separates them from the project strip", () => {
    expect(rule(".session-composer__notices")).toContain("max-width: 52rem;");
    expect(rule(".session-composer__notices")).toContain("margin: 0 auto var(--space-3);");
    expect(rule(".session-composer__notices")).toContain("overflow-wrap: anywhere;");
    expect(rule(".session-composer__notices:empty")).toContain("display: none;");
  });

  it("joins the project strip and input card without inset or overlapping borders", () => {
    const context = rule(".session-composer__context");
    expect(context).not.toContain("margin:");
    expect(context).toContain("padding: var(--space-2) var(--space-4);");
    expect(context).toContain("border-bottom: 0;");
    expect(context).toContain("border-radius: 1.25rem 1.25rem 0 0;");
    expect(rule(".session-composer__box")).toContain("border-radius: 0 0 1.25rem 1.25rem;");
  });

  it("keeps the machine label visible while a long project name shrinks", () => {
    expect(rule(".session-composer__place")).toContain("min-width: 0;");
    expect(rule(".session-composer__place:last-child")).toContain("flex: none;");
    expect(rule(".session-composer__place > span")).toContain("text-overflow: ellipsis;");
  });

  it("shrinks long drafts and attachment lists without shrinking the toolbar", () => {
    expect(rule(".session-composer")).toContain("flex: 0 1 auto;");
    expect(rule(".session-composer")).toContain("max-height: 60%;");
    for (const selector of [".session-composer__frame", ".session-composer__box"]) {
      expect(rule(selector)).toContain("display: flex;");
      expect(rule(selector)).toContain("min-height: 0;");
      expect(rule(selector)).toContain("width: 100%;");
    }
    expect(rule(".session-composer__box .chat-composer__input")).toContain("flex: 0 1 auto;");
    expect(rule(".session-composer__box .chat-queue")).toContain("max-height: 6rem;");
    expect(rule(".session-composer__box .chat-queue")).toContain("overflow-y: auto;");
    expect(styles).toContain(".session-composer__box .chat-attachments,\n.session-composer__box .chat-queue {");
    expect(rule(".session-composer__notices")).toContain("max-height: 8rem;");
    expect(rule(".session-composer__notices")).toContain("overflow-y: auto;");
    expect(rule(".session-composer__toolbar")).toContain("flex: none;");
  });
});
