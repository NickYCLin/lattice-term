/**
 * Mounts the real chat runtime with a mocked backend and fires an
 * automation. The one thing this guards is that a run actually reaches
 * the backend: the automation creates a thread and sends into it in the
 * same tick, before React has rendered the new thread, which once made
 * `send` look the thread up in a stale list and return without doing
 * anything. The run then sat on "running" for good.
 */

import { describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import type { ChatEventEnvelope } from "./agentChat";

let chatListener: ((event: { payload: ChatEventEnvelope }) => void) | null = null;
const playSound = vi.fn(async () => "disabled");
vi.mock("./notificationSounds", () => ({ playNotificationSound: (...args: unknown[]) => playSound(...(args as [])) }));

const invoke = vi.fn(async (command: string) => {
  if (command === "agent_chat_supported") return ["claude", "codex", "gemini"];
  return undefined;
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...(args as [string])),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async (name: string, listener: (event: { payload: ChatEventEnvelope }) => void) => {
  if (name === "agent-chat://event") chatListener = listener;
  return () => {};
} }));

// The runtime renders nothing, so a skeletal DOM is all react-dom needs.
function fakeNode(): Record<string, unknown> {
  const node: Record<string, unknown> = {
    nodeType: 1,
    nodeName: "DIV",
    tagName: "DIV",
    childNodes: [] as unknown[],
    style: {},
    ownerDocument: null,
    firstChild: null,
    textContent: "",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    appendChild(child: Record<string, unknown>) {
      (node.childNodes as unknown[]).push(child);
      child.parentNode = node;
      return child;
    },
    removeChild(child: unknown) {
      node.childNodes = (node.childNodes as unknown[]).filter((entry) => entry !== child);
      return child;
    },
    insertBefore(child: unknown) {
      (node.childNodes as unknown[]).push(child);
      return child;
    },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    removeAttribute() {},
  };
  return node;
}

function installFakeDom() {
  const globals = globalThis as Record<string, unknown>;
  if (globals.__latticeFakeDom) return globals.__latticeFakeDom as Record<string, unknown>;
  const document: Record<string, unknown> = {
    nodeType: 9,
    createElement: () => fakeNode(),
    createTextNode: (text: string) => ({ nodeType: 3, textContent: text }),
    createComment: () => ({ nodeType: 8 }),
    documentElement: fakeNode(),
    activeElement: null,
    addEventListener() {},
    removeEventListener() {},
  };
  const root = fakeNode();
  root.ownerDocument = document;
  document.body = root;
  (document.documentElement as Record<string, unknown>).ownerDocument = document;
  document.defaultView = globalThis;
  globals.document = document;
  globals.window = globalThis;
  class Stub {}
  for (const name of ["HTMLElement", "Element", "Node", "HTMLIFrameElement", "Event", "Text", "Comment"]) {
    globals[name] = Stub;
  }
  globals.__TAURI_INTERNALS__ = {};
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  globals.__latticeFakeDom = root;
  return root;
}

describe("useAgentAutomations", () => {
  it("records steering only after receipt and keeps late receipts with the original turn", async () => {
    invoke.mockClear();
    const root = installFakeDom();
    const { createRoot } = await import("react-dom/client");
    const { ChatRuntime } = await import("./ChatRuntime");
    type Api = import("./ChatRuntime").ChatRuntimeApi;
    let api: Api | null = null;
    const reactRoot = createRoot(root as unknown as Element);
    await act(async () => { reactRoot.render(React.createElement(ChatRuntime, { locale: "en", onChange: (next: Api) => { api = next; } })); });
    const current = () => (api as unknown as Api).chat;
    let id = "";
    await act(async () => {
      id = current().createThread({ definitionId: "codex", workingDirectory: "", permission: "ask", model: "" }).id;
      await current().send(id, "first");
      current().enqueue(id, "next turn", []);
    });
    const originalTurn = current().threads[0].runningTurnId!;
    let acknowledge!: () => void;
    invoke.mockImplementationOnce(() => new Promise(resolve => { acknowledge = () => resolve(undefined); }));
    let pending!: Promise<void>;
    await act(async () => { pending = current().steer(id, "extra", [{ path: "/fixture/a.png", name: "a.png", isImage: true }]); });
    expect(invoke).toHaveBeenLastCalledWith("agent_chat_steer", { request: { threadId: id, expectedTurnId: originalTurn,
      prompt: "extra", attachments: [{ path: "/fixture/a.png" }],
    } });
    expect(current().threads[0].items.filter(item => item.type === "user")).toHaveLength(1);
    await expect(current().steer(id, "duplicate", [])).rejects.toThrow("awaiting confirmation");
    await act(async () => { chatListener!({ payload: { threadId: id, turnId: originalTurn,
      event: { kind: "finished", error: null, nativeSessionId: "native", usage: null, costUsd: null, durationMs: null } } }); });
    const nextTurn = current().threads[0].runningTurnId!;
    expect(nextTurn).not.toBe(originalTurn);
    await act(async () => { acknowledge(); await pending; });
    const thread = current().threads[0];
    expect(thread.items.map(item => item.type === "user" ? item.text : item.type)).toEqual(["first", "extra", "turnEnd", "next turn"]);
    expect(thread.runningTurnId).toBe(nextTurn);
    expect(thread.permission).toBe("ask");
    invoke.mockRejectedValueOnce(new Error("turn ended"));
    await act(async () => { await expect(current().steer(id, "rejected", [])).rejects.toThrow("turn ended"); });
    expect(current().threads[0].items).toEqual(thread.items);
    expect(current().threads[0].runningTurnId).toBe(nextTurn);
    await act(async () => { current().removeThread(id); reactRoot.unmount(); });
  });

  it("sends queued chat input once, preserves profile context, and pauses after stop", async () => {
    invoke.mockClear();
    const root = installFakeDom();
    const { createRoot } = await import("react-dom/client");
    const { ChatRuntime } = await import("./ChatRuntime");
    type Api = import("./ChatRuntime").ChatRuntimeApi;
    let api: Api | null = null;
    const reactRoot = createRoot(root as unknown as Element);
    await act(async () => { reactRoot.render(React.createElement(ChatRuntime, { locale: "en", onChange: (next: Api) => { api = next; } })); });
    const current = () => (api as unknown as Api).chat;
    const sends = () => invoke.mock.calls.filter(call => call[0] === "agent_chat_send");
    let id = "";
    await act(async () => {
      id = current().createThread({ definitionId: "codex", workingDirectory: "", permission: "ask", model: "" }).id;
      await current().send(id, "first");
      current().enqueue(id, "second", [], "/profiles/codex");
      current().enqueue(id, "third", [], "/profiles/codex");
      current().updateThread(id, { permission: "full" });
    });
    expect(sends()).toHaveLength(1);
    expect(current().threads[0].permission).toBe("ask");
    const finish = (turnId: string, error: string | null = null) => chatListener!({ payload: { threadId: id, turnId,
      event: { kind: "finished", error, nativeSessionId: "native-queue", usage: null, costUsd: null, durationMs: null } } });
    const first = current().threads[0].runningTurnId!;
    await act(async () => { finish("stale"); finish(first); finish(first); });
    expect(sends()).toHaveLength(2);
    expect(invoke).toHaveBeenLastCalledWith("agent_chat_send", { request: expect.objectContaining({
      prompt: "second", profileConfigPath: "/profiles/codex", nativeSessionId: "native-queue", permission: "ask",
    }) });
    expect(current().threads[0].pendingInputs?.map(message => message.prompt)).toEqual(["third"]);
    const second = current().threads[0].runningTurnId!;
    await act(async () => { await current().stop(id); finish(second); });
    expect(sends()).toHaveLength(2);
    expect(current().threads[0].queuePaused).toBe(true);
    await act(async () => { current().resumeQueue(id); });
    expect(sends()).toHaveLength(3);
    expect(current().threads[0].pendingInputs).toEqual([]);
    await act(async () => {
      current().enqueue(id, "after error", []);
      finish(current().threads[0].runningTurnId!, "failed");
    });
    expect(sends()).toHaveLength(3);
    expect(current().threads[0].queuePaused).toBe(true);
    const previousStorage = globalThis.localStorage;
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => {} });
    try {
      await act(async () => { current().resumeQueue(id); });
      expect(sends()).toHaveLength(3);
      expect(current().threads[0].queueProblem).toBe("storage");
      expect(current().threads[0].pendingInputs?.map(message => message.prompt)).toEqual(["after error"]);
      expect(() => current().enqueue(id, "not saved", [])).toThrow("storage");
      expect(current().threads[0].pendingInputs).toHaveLength(1);
    } finally {
      vi.stubGlobal("localStorage", previousStorage);
    }
    await act(async () => { current().removeThread(id); reactRoot.unmount(); });
  });

  it("a run started right after its thread is created still reaches the backend", async () => {
    invoke.mockClear();
    playSound.mockClear();
    const root = installFakeDom();
    const { createRoot } = await import("react-dom/client");
    const { ChatRuntime } = await import("./ChatRuntime");
    type Api = import("./ChatRuntime").ChatRuntimeApi;
    let api: Api | null = null;
    const reactRoot = createRoot(root as unknown as Element);
    await act(async () => {
      reactRoot.render(
        React.createElement(ChatRuntime, {
          locale: "en",
          completionSound: "gentle",
          onChange: (next: Api) => {
            api = next;
          },
        }),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(api).not.toBeNull();
    const runtime = api as unknown as Api;

    let created: { id: string } | null = null;
    await act(async () => {
      created = runtime.automations.create({
        name: "nightly",
        instructions: "do it",
        definitionId: "claude",
        workingDirectory: "/tmp",
        permission: "readOnly",
        model: "",
        schedule: { kind: "interval", everyMinutes: 60 },
      });
    });
    await act(async () => {
      runtime.automations.runNow(created!.id);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const sends = invoke.mock.calls.filter((call) => call[0] === "agent_chat_send");
    expect(sends).toHaveLength(1);
    const latest = (api as unknown as Api);
    expect(latest.automations.automations[0].runs[0].outcome).toBe("running");
    expect(latest.chat.threads[0].runningTurnId).not.toBeNull();
    expect(latest.chat.threads[0].items[0]).toMatchObject({ type: "user", text: "do it" });

    const envelope: ChatEventEnvelope = {
      threadId: latest.chat.threads[0].id,
      turnId: latest.chat.threads[0].runningTurnId!,
      event: { kind: "finished", error: null, nativeSessionId: null, usage: null, costUsd: null, durationMs: null },
    };
    await act(async () => {
      chatListener!({ payload: envelope });
      chatListener!({ payload: envelope });
    });
    expect(playSound).toHaveBeenCalledTimes(1);
    expect(playSound).toHaveBeenLastCalledWith("gentle");

    await act(async () => {
      const general = runtime.chat.createThread({ definitionId: "codex", workingDirectory: "", permission: "ask", model: "", browserEnabled: true });
      await runtime.chat.send(general.id, "hello");
    });
    expect(invoke).toHaveBeenLastCalledWith("agent_chat_send", { request: expect.objectContaining({ workingDirectory: "", browserEnabled: true, prompt: "hello" }) });
    reactRoot.unmount();
  });
});
