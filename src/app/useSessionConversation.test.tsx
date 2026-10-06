import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { fakeAgentApi, fakeSession } from "./testFixtures/agentApis";
import { useSessionConversation, type SessionConversationMessage, type SessionConversationSnapshot } from "./useSessionConversation";

function snapshot(messages: SessionConversationMessage[] = []): SessionConversationSnapshot {
  return { availability: "ready", messages, truncated: false };
}

const { invoke, renderPreview } = vi.hoisted(() => ({ invoke: vi.fn(), renderPreview: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./terminalPreview", () => ({ renderTerminalPreview: renderPreview }));
beforeEach(() => {
  renderPreview.mockReset().mockImplementation(async (snapshot: string) =>
    snapshot.replace(/\x1b\[[0-9;]*m/g, ""));
});

it("reads the selected session, rejects stale reads and sends only through that session's existing queue", async () => {
  vi.useFakeTimers();
  const root = createRoot(installFakeDom() as unknown as Element);
  let finish!: (value: SessionConversationSnapshot) => void;
  let conversationReads = 0;
  invoke.mockImplementation((command: string) => {
    if (command === "agent_session_approval") return Promise.resolve(null);
    conversationReads += 1;
    return conversationReads === 1
      ? new Promise(resolve => { finish = resolve; })
      : Promise.resolve(snapshot([{ role: "assistant", text: "second session" }]));
  });
  const enqueue = vi.fn().mockRejectedValueOnce(new Error("CLI is waiting for approval")).mockResolvedValue(0);
  const agents = fakeAgentApi({ enqueue });
  let api!: ReturnType<typeof useSessionConversation>;
  function Probe({ id }: { id: string }) { api = useSessionConversation(id, agents); return null; }
  try {
    await act(async () => { root.render(<Probe id="first" />); });
    await act(async () => { root.render(<Probe id="second" />); });
    await act(async () => { finish(snapshot([{ role: "assistant", text: "stale" }])); });
    expect(api.messages[0].text).toBe("second session");
    await act(async () => { expect(await api.send("hello")).toBe(false); });
    expect(api.sendError).toContain("approval");
    await act(async () => { expect(await api.send("hello")).toBe(true); });
    expect(enqueue.mock.calls).toEqual([["second", "hello"], ["second", "hello"]]);
    expect(agents.launch).not.toHaveBeenCalled();
    expect(invoke.mock.calls.every(([command]) =>
      command === "agent_session_conversation_snapshot" || command === "agent_session_approval")).toBe(true);
    await act(async () => { root.unmount(); });
    const reads = invoke.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(invoke).toHaveBeenCalledTimes(reads);
  } finally { vi.useRealTimers(); vi.clearAllMocks(); }
});

it("shows live output during a slow transcript read and preserves the actual read error", async () => {
  vi.useFakeTimers();
  const root = createRoot(installFakeDom() as unknown as Element);
  let reject!: (error: Error) => void;
  let output!: (text: string) => void;
  const unsubscribe = vi.fn();
  const agents = fakeAgentApi({ onOutputTail: (_id, handler) => { output = handler; return unsubscribe; } });
  invoke.mockImplementation((command: string) => command === "agent_session_approval"
    ? Promise.resolve(null)
    : new Promise((_resolve, fail) => { reject = fail; }));
  const conversationReads = () => invoke.mock.calls.filter(([command]) => command === "agent_session_conversation_snapshot").length;
  let api!: ReturnType<typeof useSessionConversation>;
  function Probe() { api = useSessionConversation("selected", agents); return null; }
  try {
    await act(async () => { root.render(<Probe />); });
    await act(async () => { output("\x1b[31mWorking on files\x1b[0m"); await vi.advanceTimersByTimeAsync(8000); });
    expect(api.slow).toBe(true);
    expect(api.output).toBe("Working on files");
    expect(conversationReads()).toBe(1);
    await act(async () => { reject(new Error("The account directory is unavailable.")); });
    expect(api.readError).toBe("The account directory is unavailable.");
    expect(api.loading).toBe(false);
    expect(api.output).toBe("Working on files");
    await act(async () => { root.unmount(); });
    expect(unsubscribe).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); vi.clearAllMocks(); }
});

it("answers the terminal's permission prompt by its own id", async () => {
  vi.useFakeTimers();
  const root = createRoot(installFakeDom() as unknown as Element);
  const prompt = { requestId: "r1", toolName: "Bash", summary: "mkdir build" };
  let waiting: typeof prompt | null = prompt;
  invoke.mockImplementation((command: string) => {
    if (command === "agent_session_approval") return Promise.resolve(waiting);
    if (command === "agent_answer_approval") { waiting = null; return Promise.resolve(true); }
    return Promise.resolve(snapshot());
  });
  let api!: ReturnType<typeof useSessionConversation>;
  function Probe() { api = useSessionConversation("selected", fakeAgentApi()); return null; }
  try {
    await act(async () => { root.render(<Probe />); });
    expect(api.approval).toEqual(prompt);
    await act(async () => { await api.answer(true); });
    expect(invoke).toHaveBeenCalledWith("agent_answer_approval", { sessionId: "selected", requestId: "r1", allow: true });
    expect(api.approval).toBeNull();
    expect(api.answerError).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(api.approval).toBeNull();
    await act(async () => { root.unmount(); });
  } finally { vi.useRealTimers(); vi.clearAllMocks(); }
});

it("ignores late previews from an older output snapshot or a different session", async () => {
  vi.useFakeTimers();
  const root = createRoot(installFakeDom() as unknown as Element);
  const pending: Array<(text: string) => void> = [];
  renderPreview.mockImplementation(() => new Promise<string>(resolve => { pending.push(resolve); }));
  invoke.mockResolvedValue(snapshot());
  let output!: (text: string) => void;
  const agents = fakeAgentApi({ onOutputTail: (_id, handler) => { output = handler; return vi.fn(); } });
  let api!: ReturnType<typeof useSessionConversation>;
  function Probe({ id }: { id: string }) { api = useSessionConversation(id, agents); return null; }
  try {
    await act(async () => { root.render(<Probe id="first" />); });
    await act(async () => { output("old frame"); await vi.advanceTimersByTimeAsync(100); });
    await act(async () => { output("latest frame"); await vi.advanceTimersByTimeAsync(100); });
    await act(async () => { pending[1]("latest frame"); });
    await act(async () => { pending[0]("old frame"); });
    expect(api.output).toBe("latest frame");
    await act(async () => { output("first session pending"); await vi.advanceTimersByTimeAsync(100); });
    await act(async () => { root.render(<Probe id="second" />); });
    await act(async () => { pending[2]("first session pending"); });
    expect(api.output).toBe("");
    await act(async () => { root.unmount(); });
  } finally { vi.useRealTimers(); vi.clearAllMocks(); }
});

it("reports preview errors without displaying raw control sequences", async () => {
  vi.useFakeTimers();
  const root = createRoot(installFakeDom() as unknown as Element);
  invoke.mockResolvedValue(snapshot());
  renderPreview.mockRejectedValue(new Error("Preview could not be rendered."));
  let output!: (text: string) => void;
  const agents = fakeAgentApi({ onOutputTail: (_id, handler) => { output = handler; return vi.fn(); } });
  let api!: ReturnType<typeof useSessionConversation>;
  function Probe() { api = useSessionConversation("selected", agents); return null; }
  try {
    await act(async () => { root.render(<Probe />); });
    await act(async () => { output("\x1b[1;1HWorking"); await vi.advanceTimersByTimeAsync(100); });
    expect(api.output).toBe("");
    expect(api.outputError).toBe("Preview could not be rendered.");
    await act(async () => { root.unmount(); });
  } finally { vi.useRealTimers(); vi.clearAllMocks(); }
});

it("refreshes immediately when the selected session captures its native ID", async () => {
  vi.useFakeTimers();
  const root = createRoot(installFakeDom() as unknown as Element);
  let reads = 0;
  invoke.mockImplementation((command: string) => {
    if (command === "agent_session_approval") return Promise.resolve(null);
    reads += 1;
    return Promise.resolve(reads === 1
      ? { availability: "waitingForIdentity", messages: [], truncated: false }
      : snapshot([{ role: "assistant", text: "native reply" }]));
  });
  let agents = fakeAgentApi({ sessions: [fakeSession({ sessionId: "selected" })] });
  let api!: ReturnType<typeof useSessionConversation>;
  function Probe() { api = useSessionConversation("selected", agents); return null; }
  try {
    await act(async () => { root.render(<Probe />); });
    expect(api.availability).toBe("waitingForIdentity");
    agents = fakeAgentApi({ sessions: [fakeSession({ sessionId: "selected", capturedSessionId: "native" })] });
    await act(async () => { root.render(<Probe />); });
    expect(reads).toBe(2);
    expect(api.availability).toBe("ready");
    expect(api.messages[0].text).toBe("native reply");
    agents = fakeAgentApi({ sessions: [...agents.sessions, fakeSession({ sessionId: "other", capturedSessionId: "other-native" })] });
    await act(async () => { root.render(<Probe />); });
    expect(reads).toBe(2);
    await act(async () => { root.unmount(); });
  } finally { vi.useRealTimers(); vi.clearAllMocks(); }
});

it("serializes reads across ID capture and rejects the old identity's result", async () => {
  vi.useFakeTimers();
  const root = createRoot(installFakeDom() as unknown as Element);
  let finish!: (value: SessionConversationSnapshot) => void;
  let reads = 0;
  invoke.mockImplementation((command: string) => {
    if (command === "agent_session_approval") return Promise.resolve(null);
    reads += 1;
    return reads === 1 ? new Promise(resolve => { finish = resolve; })
      : Promise.resolve({ ...snapshot([{ role: "assistant", text: "current" }]), truncated: true });
  });
  let agents = fakeAgentApi({ sessions: [fakeSession({ sessionId: "selected" })] });
  let api!: ReturnType<typeof useSessionConversation>;
  function Probe() { api = useSessionConversation("selected", agents); return null; }
  try {
    await act(async () => { root.render(<Probe />); });
    agents = fakeAgentApi({ sessions: [fakeSession({ sessionId: "selected", capturedSessionId: "native" })] });
    await act(async () => { root.render(<Probe />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(reads).toBe(1);
    expect(api.messages).toEqual([]);
    await act(async () => { finish(snapshot([{ role: "assistant", text: "stale" }])); });
    expect(reads).toBe(2);
    expect(api.messages[0].text).toBe("current");
    expect(api.truncated).toBe(true);
    await act(async () => { root.unmount(); });
  } finally { vi.useRealTimers(); vi.clearAllMocks(); }
});

it("keeps the last readable snapshot and truncation notice when a retry fails", async () => {
  vi.useFakeTimers();
  const root = createRoot(installFakeDom() as unknown as Element);
  let reads = 0;
  invoke.mockImplementation((command: string) => {
    if (command === "agent_session_approval") return Promise.resolve(null);
    reads += 1;
    return reads === 1
      ? Promise.resolve({ ...snapshot([{ role: "assistant", text: "retained" }]), truncated: true })
      : Promise.reject(new Error("read failed"));
  });
  let api!: ReturnType<typeof useSessionConversation>;
  const agents = fakeAgentApi();
  function Probe() { api = useSessionConversation("selected", agents); return null; }
  try {
    await act(async () => { root.render(<Probe />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(api.messages[0].text).toBe("retained");
    expect(api.availability).toBe("ready");
    expect(api.truncated).toBe(true);
    expect(api.readError).toBe("read failed");
    await act(async () => { root.unmount(); });
  } finally { vi.useRealTimers(); vi.clearAllMocks(); }
});
