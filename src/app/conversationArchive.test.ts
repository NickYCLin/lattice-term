import { describe, expect, it } from "vitest";
import { parseConversationArchive } from "./conversationArchive";

describe("conversation export", () => {
  it("reads Claude chat messages without retaining tool blocks", () => {
    expect(parseConversationArchive([{ name: "Notes", chat_messages: [
      { sender: "human", text: "question" },
      { sender: "assistant", content: [{ type: "text", text: "answer" }, { type: "tool_use", id: "secret" }] },
    ] }])).toEqual([{ definitionId: "claude", title: "Notes", messages: [
      { role: "user", text: "question" }, { role: "assistant", text: "answer" },
    ] }]);
  });

  it("follows the current branch of a ChatGPT/Codex export mapping", () => {
    expect(parseConversationArchive([{ title: "Work", current_node: "a", mapping: {
      u: { parent: null, message: { author: { role: "user" }, content: { parts: ["hi"] } } },
      a: { parent: "u", message: { author: { role: "assistant" }, content: { parts: ["hello"] } } },
      other: { parent: "u", message: { author: { role: "assistant" }, content: { parts: ["old branch"] } } },
    } }])[0].messages).toEqual([{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }]);
  });

  it("ignores unrelated or malformed data", () => {
    expect(parseConversationArchive({ credentials: { token: "private" } })).toEqual([]);
    expect(parseConversationArchive([{ messages: [{ role: "tool", text: "secret" }] }])).toEqual([]);
  });
});
