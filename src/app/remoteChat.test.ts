import { describe, expect, it, vi } from "vitest";
import { createThread, type ChatThread } from "./agentChat";
import { fakeChatApi } from "./testFixtures/agentApis";
import { performRemoteChat, remotePage, remoteThread } from "./remoteChat";
function thread() { return createThread({ definitionId: "codex", workingDirectory: "/work", permission: "ask", model: "" }, "thread", 1); }
describe("Remote conversation projection", () => {
  it("pages real transcript items within the wire budget without exporting account or native session identities", () => {
    const value = { ...thread(), nativeSessionId: "private-native-id", accountProfileId: "private-profile", items: Array.from({length: 100}, (_, i) => ({ type: "text" as const, id: `item-${i}`, text: "中文\\\"".repeat(9000) })) };
    const last = remotePage(value, null);
    expect(new TextEncoder().encode(JSON.stringify(last)).length).toBeLessThan(55 * 1024);
    expect(last.items[last.items.length - 1]?.id).toBe("item-99");
    expect(last.items.every(item => item.truncated)).toBe(true);
    const older = remotePage(value, last.before);
    expect(older.items[older.items.length - 1]?.id).not.toBe(last.items[last.items.length - 1]?.id);
    expect(JSON.stringify(remoteThread(value))).not.toContain("private-");
    expect(() => remotePage(value, "deleted-item")).toThrow("changed");
  });
  it("uses current host state, rejects stale turns and never selects a missing account", async () => {
    let value: ChatThread = { ...thread(), runningTurnId: "new-turn" };
    const chat = fakeChatApi({ threads: [value], getThread: () => value });
    await expect(performRemoteChat(chat, [], { kind: "stop", threadId: value.id, turnId: "old-turn" })).rejects.toThrow("changed");
    expect(chat.stop).not.toHaveBeenCalled();
    await performRemoteChat(chat, [], { kind: "stop", threadId: value.id, turnId: "new-turn" });
    expect(chat.stop).toHaveBeenCalledWith(value.id, "new-turn");
    value = { ...thread(), runningTurnId: null, accountProfileId: "gone" };
    await expect(performRemoteChat(chat, [], { kind: "send", threadId: value.id, text: "hello" })).rejects.toThrow("account");
    expect(chat.send).not.toHaveBeenCalled();
  });
  it("sends to the existing thread and creates a separate conversation from host settings", async () => {
    const value = thread();
    const create = vi.fn(() => ({ ...value, id: "new" }));
    const chat = fakeChatApi({ threads: [value], getThread: () => value, createThread: create });
    await performRemoteChat(chat, [], { kind: "send", threadId: value.id, text: "接續處理" });
    expect(chat.send).toHaveBeenCalledWith(value.id, "接續處理", [], null);
    await performRemoteChat(chat, [], { kind: "create", templateId: value.id });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ workingDirectory: "/work", permission: "ask", definitionId: "codex", activate: false }));
  });
});
