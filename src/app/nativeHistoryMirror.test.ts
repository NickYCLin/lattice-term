import { expect, it } from "vitest";
import { createThread, importNativeConversation, promptForTurn, type ChatThread, type NativeHistoryMessage } from "./agentChat";
import { isNativeHistoryMirror, nativeMessageTail, refreshNativeHistoryMirror } from "./nativeHistoryMirror";
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
  expect(refreshNativeHistoryMirror(continued, entry, snapshot).items).toBe(continued.items);
});
it("tracks archive changes from the exact snapshot even when archives are hidden from the list", () => {
  const old = mirror();
  const archived = refreshNativeHistoryMirror(old, entry, { messages: [], truncated: false, archived: true });
  expect(archived.nativeHistoryArchived).toBe(true);
  const restored = refreshNativeHistoryMirror(archived, { ...entry, archived: true }, { messages: [], truncated: false, archived: false });
  expect(restored.nativeHistoryArchived).toBe(false);
});

function continued(): ChatThread {
  return { ...createThread({ definitionId: "codex", workingDirectory: "/work", model: "", permission: "ask" }),
    nativeSessionId: "native", accountProfileId: "account", title: "Renamed", items: [
      { type: "user", id: "local:user", text: "local question", at: 1 },
      { type: "notice", id: "local:tool", text: "preserve tool and approval context" },
      { type: "text", id: "local:answer", text: "local answer" },
    ] };
}
const nativeMessages: NativeHistoryMessage[] = [
  { role: "user", text: "local question" }, { role: "assistant", text: "local answer" },
  { role: "user", text: "question in the native app" }, { role: "assistant", text: "native reply" },
];

it("reads external turns after a locally created or continued conversation without replacing rich items", () => {
  const old = continued();
  expect(isNativeHistoryMirror(old)).toBe(true);
  const next = refreshNativeHistoryMirror(old, entry, { messages: nativeMessages, truncated: false });
  expect(next.items.slice(0, old.items.length)).toEqual(old.items);
  expect(next.items.slice(old.items.length)).toMatchObject([
    { type: "user", text: "question in the native app" }, { type: "text", text: "native reply" },
  ]);
  expect(next.nativeHistorySource).toBeUndefined();
  expect(next.nativeSessionId).toBe("native");
  expect(refreshNativeHistoryMirror(next, entry, { messages: nativeMessages, truncated: false })).toBe(next);
});

it("appends a later native turn after returning to LatticeTerm and back again", () => {
  const first = refreshNativeHistoryMirror(continued(), entry, { messages: nativeMessages, truncated: false });
  const second = { ...first, items: [...first.items,
    { type: "user" as const, id: "next:user", text: "second local question", at: 2 },
    { type: "text" as const, id: "next:answer", text: "second local reply" },
  ] };
  const messages: NativeHistoryMessage[] = [...nativeMessages,
    { role: "user", text: "second local question" }, { role: "assistant", text: "second local reply" },
    { role: "user", text: "second native question" }, { role: "assistant", text: "second native reply" },
  ];
  const next = refreshNativeHistoryMirror(second, entry, { messages, truncated: false });
  expect(next.items).toHaveLength(second.items.length + 2);
  expect(next.items.slice(0, second.items.length)).toEqual(second.items);
  expect(refreshNativeHistoryMirror(next, entry, { messages, truncated: false })).toBe(next);
});

it("does not overwrite local turns with stale, conflicting, queued or cross-account snapshots", () => {
  const old = continued();
  const stale = { messages: [{ role: "user" as const, text: "older question" }], truncated: true };
  const waiting = refreshNativeHistoryMirror(old, entry, stale);
  expect(waiting.items).toBe(old.items);
  expect(waiting.nativeSyncPending).toBe(true);
  expect(refreshNativeHistoryMirror(waiting, entry, stale)).toBe(waiting);
  expect(refreshNativeHistoryMirror(waiting, entry, { messages: nativeMessages, truncated: false }).nativeSyncPending).toBe(false);
  expect(refreshNativeHistoryMirror(old, entry, { messages: [{ role: "user", text: "local question" },
    { role: "assistant", text: "different answer" }, ...nativeMessages.slice(2)], truncated: false }).items).toBe(old.items);
  const queued = { ...old, pendingInputs: [{ id: "queue", prompt: "pending", attachments: [], profileConfigPath: null, createdAt: 1 }] };
  expect(refreshNativeHistoryMirror(queued, entry, { messages: nativeMessages, truncated: false })).toBe(queued);
  expect(refreshNativeHistoryMirror(old, { ...entry, profileId: "other" }, { messages: nativeMessages, truncated: false })).toBe(old);
});

it("aligns final replies even when clients split commentary differently", () => {
  const old = continued();
  old.items.splice(1, 0, { type: "text", id: "commentary", text: "local commentary" });
  expect(nativeMessageTail(old.items, [nativeMessages[0], { role: "assistant", text: "native commentary" }, ...nativeMessages.slice(1)])).toBe(3);
});

it("rejects ambiguous repeated turns instead of guessing an append point", () => {
  expect(nativeMessageTail(continued().items, [...nativeMessages, ...nativeMessages])).toBeNull();
});

it("aligns the current user message inside a LatticeTerm memory handoff", () => {
  const old = continued();
  const prompt = promptForTurn({ ...old, handoff: { sourceDefinitionId: "claude", transcript: "previous assistant context" } }, "local question");
  expect(nativeMessageTail(old.items, [{ role: "user", text: prompt }, ...nativeMessages.slice(1)])).toBe(2);
});

it("does not poll cloud imports or active terminal handoffs", () => {
  expect(isNativeHistoryMirror({ ...continued(), archived: true })).toBe(false);
  expect(isNativeHistoryMirror({ ...continued(), continuedInSession: true })).toBe(false);
});

it("imports tool input and output as one read-only historical card and refreshes it", () => {
  const messages: NativeHistoryMessage[] = [
    { role: "user", text: "inspect" },
    { role: "assistant", text: '{"command":"pwd"}', tool: { callId: "call-1", name: "shell", kind: "call" } },
    { role: "assistant", text: "/work", tool: { callId: "call-1", name: null, kind: "result" } },
    { role: "assistant", text: "done" },
  ];
  const first = refreshNativeHistoryMirror(mirror(), entry, { messages, truncated: false });
  expect(first.items).toHaveLength(3);
  expect(first.items[1]).toMatchObject({ type: "tool", name: "shell", output: "/work", done: true });
  expect(refreshNativeHistoryMirror(first, entry, { messages, truncated: false })).toBe(first);
  const changed = messages.map(message => message.tool?.kind === "result" ? { ...message, text: "/new" } : message);
  expect(refreshNativeHistoryMirror(first, entry, { messages: changed, truncated: false }).items[1])
    .toMatchObject({ type: "tool", output: "/new" });
  expect(first.items[1]).toMatchObject({ output: "/work" });
});

it("aligns locally continued messages across native tools without treating tools as assistant replies", () => {
  const messages: NativeHistoryMessage[] = [nativeMessages[0],
    { role: "assistant", text: "args", tool: { callId: "call-1", name: "shell", kind: "call" } },
    { role: "assistant", text: "result", tool: { callId: "call-1", name: null, kind: "result" } },
    ...nativeMessages.slice(1),
  ];
  expect(nativeMessageTail(continued().items, messages)).toBe(4);
  const next = refreshNativeHistoryMirror(continued(), entry, { messages, truncated: false });
  expect(next.items.slice(-2)).toMatchObject([{ type: "user", text: nativeMessages[2].text }, { type: "text", text: nativeMessages[3].text }]);
  expect(refreshNativeHistoryMirror(next, entry, { messages, truncated: false })).toBe(next);
});

it("does not duplicate trailing tools when a locally continued transcript is polled again", () => {
  const messages: NativeHistoryMessage[] = [...nativeMessages,
    { role: "assistant", text: "args", tool: { callId: "trailing", name: "shell", kind: "call" } },
    { role: "assistant", text: "result", tool: { callId: "trailing", name: null, kind: "result" } },
  ];
  const first = refreshNativeHistoryMirror(continued(), entry, { messages, truncated: false });
  expect(first.items.filter(item => item.type === "tool")).toHaveLength(1);
  expect(refreshNativeHistoryMirror(first, entry, { messages, truncated: false })).toBe(first);
});

it("omits historical image path calls and pixel-unavailable placeholders", () => {
  const messages: NativeHistoryMessage[] = [
    { role: "user", text: "inspect" },
    { role: "assistant", text: '{"path":"/private/photo.png"}', tool: { callId: "image-1", name: "functions.view_image", kind: "call" } },
    { role: "assistant", text: "pixels unavailable", tool: { callId: "image-1", name: null, kind: "result" } },
    { role: "assistant", text: "done" },
  ];
  const result = refreshNativeHistoryMirror(mirror(), entry, { messages, truncated: false });
  expect(result.items).toHaveLength(2);
  expect(JSON.stringify(result.items)).not.toMatch(/private|photo.png|pixels unavailable|view_image/);
});

it("keeps one stable tool card for repeated or reordered historical rows", () => {
  const messages: NativeHistoryMessage[] = [
    { role: "assistant", text: "result", tool: { callId: "same", name: null, kind: "result" } },
    { role: "assistant", text: "args", tool: { callId: "same", name: "shell", kind: "call" } },
    { role: "assistant", text: "result", tool: { callId: "same", name: null, kind: "result" } },
  ];
  const result = refreshNativeHistoryMirror(mirror(), entry, { messages, truncated: false });
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({ type: "tool", name: "shell", summary: "args", output: "result" });
});
