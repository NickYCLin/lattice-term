import { expect, it } from "vitest";
import { importNativeConversation } from "./agentChat";
import { refreshNativeHistoryMirror } from "./nativeHistoryMirror";
import type { LocalConversation } from "./localConversationSessions";

const entry: LocalConversation = { definitionId: "codex", profileId: "account", nativeSessionId: "native", workingDirectory: "/work", title: "Renamed", resumable: true, updatedAt: 2 };
function mirror() {
  return importNativeConversation({ definitionId: "codex", accountProfileId: "account", nativeSessionId: "native", title: "Old", workingDirectory: "/work", messages: [{ role: "user", text: "old" }] });
}
it("refreshes a previously imported mirror in place, including archive and truncation metadata", () => {
  const old = mirror();
  const snapshot = { messages: [{ role: "assistant" as const, text: "new message from Desktop" }], truncated: true };
  const next = refreshNativeHistoryMirror(old, { ...entry, archived: true }, snapshot);
  expect(next.id).toBe(old.id); expect(next.nativeSessionId).toBe(old.nativeSessionId);
  expect(next).toMatchObject({ title: "Renamed", nativeHistoryArchived: true, historyTruncated: true });
  expect(next.items).toEqual([{ type: "text", id: "history:0", text: "new message from Desktop" }]);
  expect(refreshNativeHistoryMirror(next, { ...entry, archived: true }, snapshot)).toBe(next);
});
it("does not cross accounts or replace a running turn or locally continued rich conversation", () => {
  const old = mirror(); const snapshot = { messages: [], truncated: false };
  expect(refreshNativeHistoryMirror(old, { ...entry, profileId: "other" }, snapshot)).toBe(old);
  const running = { ...old, runningTurnId: "turn" };
  expect(refreshNativeHistoryMirror(running, entry, snapshot)).toBe(running);
  const continued = { ...old, items: [...old.items, { type: "text" as const, id: "local", text: "local answer" }] };
  expect(refreshNativeHistoryMirror(continued, entry, snapshot)).toBe(continued);
});
