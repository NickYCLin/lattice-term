import { describe, expect, it, vi } from "vitest";
import { createThread, type ChatThread } from "./agentChat";
import { fakeChatApi } from "./testFixtures/agentApis";
import { performRemoteChat, remotePage, remoteThread } from "./remoteChat";
function thread() { return createThread({ definitionId: "codex", workingDirectory: "/work", permission: "ask", model: "" }, "thread", 1); }
describe("Remote conversation projection", () => {
  it("binds supplemental instructions to the observed Codex turn", async () => {
    const value = { ...thread(), runningTurnId: "active-turn" };
    const steer = vi.fn(async () => {});
    const chat = fakeChatApi({ threads: [value], steer });
    expect(remoteThread(value).canSteer).toBe(true);
    await performRemoteChat(chat, [], { kind: "steer", threadId: value.id, turnId: "active-turn", text: "先檢查測試\n再修改" });
    expect(steer).toHaveBeenCalledWith(value.id, "先檢查測試\n再修改", [], "active-turn");
    await expect(performRemoteChat(chat, [], { kind: "steer", threadId: value.id, turnId: "expired-turn", text: "不要送到下一輪" })).rejects.toThrow("changed");
    expect(steer).toHaveBeenCalledTimes(1);
  });
  it("does not steer unsupported, idle, queued or approval-blocked conversations", async () => {
    for (const patch of [
      { definitionId: "claude" as const, runningTurnId: "turn" },
      { runningTurnId: null },
      { runningTurnId: "turn", pendingInputs: [{ id: "queued", prompt: "next", attachments: [], profileConfigPath: null, createdAt: 1 }] },
      { runningTurnId: "turn", items: [{ id: "approval", type: "approval" as const, requestId: "request", name: "tool", summary: "review", input: "{}", decision: "pending" as const }] },
    ]) {
      const value = { ...thread(), ...patch };
      const steer = vi.fn(async () => {});
      expect(remoteThread(value).canSteer).toBe(false);
      await expect(performRemoteChat(fakeChatApi({ threads: [value], steer }), [], { kind: "steer", threadId: value.id, turnId: "turn", text: "hello" })).rejects.toThrow();
      expect(steer).not.toHaveBeenCalled();
    }
  });
  it.each([" ", "\0", "中".repeat(5462)])("rejects empty, NUL or oversized instructions before dispatch", async (text) => {
    const value = { ...thread(), runningTurnId: "turn" };
    const steer = vi.fn(async () => {});
    await expect(performRemoteChat(fakeChatApi({ threads: [value], steer }), [], { kind: "steer", threadId: value.id, turnId: "turn", text })).rejects.toThrow("UTF-8");
    expect(steer).not.toHaveBeenCalled();
  });
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
  it("does not lose a page when tool output consists of JSON-escaped control bytes", () => {
    const value = { ...thread(), items: [{ type: "text" as const, id: "control-output", text: "\u0001".repeat(12000) }] };
    const page = remotePage(value, null);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: "control-output", truncated: true });
    expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThan(40 * 1024);
  });
  it("keeps the full stored thread list inside the encrypted response budget", async () => {
    const threads = Array.from({ length: 50 }, (_, index) => ({ ...thread(), id: `thread-${index}`, title: "\u0001".repeat(2000), workingDirectory: "\u0002".repeat(6000) }));
    const result = await performRemoteChat(fakeChatApi({ threads }), [], { kind: "list" });
    expect(result).toHaveLength(50);
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(55 * 1024);
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
