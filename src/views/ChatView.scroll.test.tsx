import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { allNodes, installHostDom, props } from "../components/agents/testFixtures/interactionDom";
import { fakeAgentApi, fakeAutomationsApi, fakeChatApi, fakeThread } from "../app/testFixtures/agentApis";
import { I18nProvider } from "../i18n";
import { ChatView } from "./ChatView";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("../app/nativeRuntime", () => ({ hasDesktopBackend: () => false }));
vi.mock("../app/fileDrop", () => ({ useFileDrop: () => ({ dragging: false }) }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("does not reset the reading position for an unchanged-size refresh before the scroll event arrives", async () => {
  const container = installHostDom();
  vi.stubGlobal("addEventListener", () => {});
  vi.stubGlobal("removeEventListener", () => {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  const root = createRoot(container as unknown as Element);
  const agents = fakeAgentApi();
  let thread = fakeThread({ items: [
    { type: "tool", id: "tool", name: "exec", summary: "Synthetic command", output: "Synthetic result", done: true, isError: false },
    { type: "text", id: "reply", text: "Synthetic completed reply" },
  ] });
  const render = () => <I18nProvider locale="zh-TW"><ChatView agents={agents}
    chat={fakeChatApi({ threads: [thread], activeThreadId: thread.id })}
    automations={fakeAutomationsApi()} onOpenSession={() => {}} /></I18nProvider>;
  try {
    await act(async () => root.render(render()));
    const node = allNodes(container).find(node => props(node)?.className === "chat-messages")!;
    expect(node).toBeDefined();
    let top = 0;
    let height = 2000;
    const writes: number[] = [];
    Object.defineProperties(node, {
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, value: 600 },
      scrollTop: { configurable: true, get: () => top, set: (value: number) => { writes.push(value); top = Math.min(value, height - 600); } },
    });
    thread = { ...thread, items: [...thread.items] };
    await act(async () => root.render(render()));
    expect(top).toBe(1400);
    writes.length = 0;
    // A browser updates scrollTop before dispatching its queued scroll event.
    top = 1376;
    thread = { ...thread, items: [...thread.items] };
    await act(async () => root.render(render()));
    expect(writes).toEqual([]);
    expect(top).toBe(1376);
    const card = allNodes(container).find(node => props(node)?.className?.includes("chat-card--tool"));
    // New text may arrive in the same frame as upward wheel intent.
    props(node).onWheel({ currentTarget: node, deltaY: -24 });
    height += 100;
    thread = { ...thread, items: [...thread.items, { type: "text", id: "next", text: "A new reply" }] };
    await act(async () => root.render(render()));
    expect(writes).toEqual([]);
    expect(top).toBe(1376);
    expect(allNodes(container).some(node => node === card)).toBe(true);
    // Returning to the bottom resumes following real layout changes.
    top = height - 600;
    props(node).onScroll({ currentTarget: node });
    height += 120;
    thread = { ...thread, items: [...thread.items, { type: "text", id: "last", text: "Another reply" }] };
    await act(async () => root.render(render()));
    expect(top).toBe(height - 600);
    expect(writes).toEqual([height]);
  } finally { await act(async () => root.unmount()); }
});
