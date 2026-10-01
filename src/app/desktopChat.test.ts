import { describe, expect, it, vi } from "vitest";
import { createThread, type ChatThread } from "./agentChat";
import { fakeChatApi } from "./testFixtures/agentApis";
import { chatIdentity, performDesktopChat, type ChatAccess, type DesktopChatAction } from "./desktopChat";
import type { ChatAccountProfile } from "./chatAccountProfiles";

const original = () => createThread({ definitionId: "codex", workingDirectory: "/project", permission: "ask", model: "original-model" }, "original-thread", 1);
const access = (thread: ChatThread, profiles: readonly ChatAccountProfile[] = []): ChatAccess => ({ targetId: "shared-target", read: true, control: true, identity: chatIdentity(thread, profiles) });
const request = (action: DesktopChatAction) => ({ id: "request", targetId: "shared-target", threadId: "original-thread", action });
describe("explicit standalone chat sharing", () => {
  it("does not reveal an unshared thread or accept an old target", async () => {
    const thread = original();
    const api = fakeChatApi({ threads: [thread] });
    await expect(performDesktopChat(api, [], request({ kind: "read" }), undefined, false)).rejects.toThrow("Sharing ended");
    await expect(performDesktopChat(api, [], request({ kind: "read" }), { ...access(thread), targetId: "retired" }, false)).rejects.toThrow("Sharing ended");
  });
  it("keeps read and send permissions independent", async () => {
    const thread = original(); const send = vi.fn();
    const api = fakeChatApi({ threads: [thread], send });
    await expect(performDesktopChat(api, [], request({ kind: "read" }), { ...access(thread), read: false }, false)).rejects.toThrow("Reading");
    await expect(performDesktopChat(api, [], request({ kind: "send", text: "hello", requestId: "once" }), { ...access(thread), control: false }, false)).rejects.toThrow("Sending");
    expect(send).not.toHaveBeenCalled();
  });
  it("pages the original messages with the returned cursor", async () => {
    const thread = { ...original(), items: Array.from({ length: 60 }, (_, i) => ({ id: `message-${i}`, type: "text" as const, text: `${i}` })) };
    const api = fakeChatApi({ threads: [thread] });
    const last = await performDesktopChat(api, [], request({ kind: "read" }), access(thread), false) as { before: string; items: { id: string }[] };
    const first = await performDesktopChat(api, [], request({ kind: "read", before: last.before }), access(thread), false) as { before: null; items: { id: string }[] };
    expect(first.before).toBeNull();
    expect([...first.items, ...last.items].map(item => item.id)).toEqual(thread.items.map(item => item.id));
  });
  it("uses the existing provider, model and account without creating or changing a thread", async () => {
    const profile: ChatAccountProfile = { id: "account", definitionId: "codex", configDirectory: "/approved/account", name: "Account" };
    const thread = { ...original(), provider: "cliproxyapi" as const, proxyId: "original-proxy", accountProfileId: profile.id };
    const send = vi.fn(async () => {}); const create = vi.fn(); const update = vi.fn();
    const api = fakeChatApi({ threads: [thread], send, createThread: create, updateThread: update });
    await expect(performDesktopChat(api, [profile], request({ kind: "send", text: "continue", requestId: "once" }), access(thread, [profile]), false)).resolves.toEqual({ threadId: thread.id, accepted: true });
    expect(send).toHaveBeenCalledExactlyOnceWith(thread.id, "continue", [], profile.configDirectory);
    expect(create).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
    expect(thread.provider).toBe("cliproxyapi"); expect(thread.proxyId).toBe("original-proxy"); expect(thread.model).toBe("original-model");
  });
  it.each([
    { runningTurnId: "turn" },
    { pendingInputs: [{ id: "q", prompt: "queued", attachments: [], profileConfigPath: null, createdAt: 1 }] },
    { items: [{ type: "approval" as const, id: "a", requestId: "approval", name: "tool", summary: "approval", input: "{}", decision: "pending" as const }] },
    { nativeHistoryArchived: true }, { archived: true }, { shelvedAt: 2 },
  ])("refuses sending when busy, queued, awaiting approval or archived: %j", async patch => {
    const thread = { ...original(), ...patch }; const send = vi.fn(); const respond = vi.fn();
    await expect(performDesktopChat(fakeChatApi({ threads: [thread], send, respond }), [], request({ kind: "send", text: "hello", requestId: "once" }), access(thread), false)).rejects.toThrow("Cannot send");
    expect(send).not.toHaveBeenCalled(); expect(respond).not.toHaveBeenCalled();
  });
  it("protects drafts and rejects settings changed after sharing", async () => {
    const thread = original(); const send = vi.fn();
    const api = fakeChatApi({ threads: [thread], send }); const grant = access(thread);
    await expect(performDesktopChat(api, [], request({ kind: "send", text: "hello", requestId: "once" }), grant, true)).rejects.toThrow("draft");
    for (const patch of [{ model: "other" }, { accountProfileId: "other" }, { provider: "cliproxyapi" as const, proxyId: "other" }, { permission: "full" as const }]) {
      await expect(performDesktopChat(fakeChatApi({ threads: [{ ...thread, ...patch }], send }), [], request({ kind: "send", text: "hello", requestId: "once" }), grant, false)).rejects.toThrow("configuration changed");
    }
    expect(send).not.toHaveBeenCalled();
  });
  it.each([" ", "hello\u0000", "x".repeat(16385)])("rejects malformed messages", async text => {
    const thread = original(); const send = vi.fn();
    await expect(performDesktopChat(fakeChatApi({ threads: [thread], send }), [], request({ kind: "send", text, requestId: "once" }), access(thread), false)).rejects.toThrow("Invalid message");
    expect(send).not.toHaveBeenCalled();
  });
});
