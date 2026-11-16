import { expect, it } from "vitest";
import { conversationLink, parseConversationLink, searchConversation } from "./conversationNavigation";
it("finds visible message and tool content without exposing a separate transcript", () => {
  expect(searchConversation([{ type: "user", id: "u", text: "需求 Alpha", at: 1 }, { type: "tool", id: "t", name: "read", summary: "file", output: "alpha result", done: true, isError: false }], " ALPHA ")).toEqual(["u", "t"]);
  expect(searchConversation([], "")).toEqual([]);
});
it("deep links only select a bounded local conversation identifier", () => {
  expect(parseConversationLink(conversationLink("chat-123_abc"))).toBe("chat-123_abc");
  for (const bad of ["https://chat/id", "latticeterm://chat/../secret", "latticeterm://chat/id?send=bad", "latticeterm://chat/%2Fsecret", "latticeterm://chat/id#run", "latticeterm://chat/%00"]) expect(parseConversationLink(bad)).toBeNull();
});

it("selects session deep links without accepting commands, paths, or extra parameters", async () => {
  const { sessionConversationLink, parseConversationLocation } = await import("./conversationNavigation");
  expect(parseConversationLocation(sessionConversationLink("agent-session-123"))).toEqual({ kind: "session", id: "agent-session-123" });
  expect(parseConversationLocation(conversationLink("thread_123"))).toEqual({ kind: "chat", id: "thread_123" });
  for (const value of ["latticeterm://session/id?send=bad", "latticeterm://session/../id", "latticeterm://session/id#run", "latticeterm://session/%2Ftmp", "latticeterm://session/", "latticeterm://session/" + "a".repeat(257)]) expect(parseConversationLocation(value)).toBeNull();
});
