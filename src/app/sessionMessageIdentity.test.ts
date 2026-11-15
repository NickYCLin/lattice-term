import { expect, it } from "vitest";
import { initialSessionMessages, sessionMessageReducer } from "./sessionMessageIdentity";
import type { SessionConversationMessage } from "./useSessionConversation";

const reply = (text: string): SessionConversationMessage => ({ role: "assistant", text });
const tool = (id: number): SessionConversationMessage => ({ role: "assistant", text: "hidden output",
  tool: { callId: `call-${id}`, name: "exec", kind: "result" } });

it("keeps image and message identities when hidden CLI rows roll out of the 300-row window", () => {
  const raw = [...Array.from({ length: 298 }, (_, i) => tool(i)), reply("Read this reply"),
    { role: "user" as const, text: '<image path="/synthetic/picture.png"></image>' }];
  const first = sessionMessageReducer(initialSessionMessages, { kind: "snapshot", messages: raw });
  const next = sessionMessageReducer(first, { kind: "snapshot", messages: [...raw.slice(1), tool(300)] });
  expect(next.messages).toHaveLength(300);
  expect(next.messages[297]).toBe(first.messages[298]);
  expect(next.messages[298]).toBe(first.messages[299]);
  expect(next.messages[299].renderId).not.toBe(first.messages[299].renderId);
});

it("reuses an unchanged snapshot despite newly decoded objects and tool property order", () => {
  const first = sessionMessageReducer(initialSessionMessages, { kind: "snapshot", messages: [tool(1), reply("unchanged")] });
  const raw = [{ ...tool(1), tool: { kind: "result" as const, name: "exec", callId: "call-1" } }, reply("unchanged")];
  expect(sessionMessageReducer(first, { kind: "snapshot", messages: raw })).toBe(first);
});

it("retains overlapping visible history and does not collapse repeated messages", () => {
  const first = sessionMessageReducer(initialSessionMessages, { kind: "snapshot", messages: [reply("repeat"), reply("repeat"), reply("picture")] });
  const next = sessionMessageReducer(first, { kind: "snapshot", messages: [reply("repeat"), reply("picture"), reply("repeat")] });
  expect(next.messages.map(message => message.text)).toEqual(["repeat", "picture", "repeat"]);
  expect(new Set(next.messages.map(message => message.renderId)).size).toBe(3);
  expect(next.messages[1]).toBe(first.messages[2]);
});

it("does not reuse another conversation's rendering identities after an identity reset", () => {
  const first = sessionMessageReducer(initialSessionMessages, { kind: "snapshot", messages: [reply("same text")] });
  const cleared = sessionMessageReducer(first, { kind: "reset" });
  const next = sessionMessageReducer(cleared, { kind: "snapshot", messages: [reply("same text")] });
  expect(cleared.messages).toEqual([]);
  expect(next.messages[0].renderId).not.toBe(first.messages[0].renderId);
});
