import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { allNodes, installHostDom, onClick, props } from "../agents/testFixtures/interactionDom";
import { ConversationInfo } from "./ConversationInfo";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("reveals the explanation only on request and supports Escape and outside dismissal", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  const listeners = new Map<string, EventListener>();
  vi.spyOn(document, "addEventListener").mockImplementation((name, listener) => { listeners.set(name, listener as EventListener); });
  vi.spyOn(document, "removeEventListener").mockImplementation((name) => { listeners.delete(name); });
  try {
    await act(async () => root.render(<ConversationInfo label="對話接手說明">只轉交近期文字對話。</ConversationInfo>));
    const button = allNodes(container).find(node => node.tagName === "BUTTON")!;
    const focus = vi.spyOn(button, "focus");
    for (const node of allNodes(container)) Object.assign(node, { contains: (target: unknown) => allNodes(node).includes(target as typeof node) });
    expect(props(button)["aria-expanded"]).toBe(false);
    expect(container.textContent).not.toContain("只轉交近期文字對話");
    await act(async () => onClick(button)());
    expect(props(button)["aria-expanded"]).toBe(true);
    expect(container.textContent).toContain("只轉交近期文字對話");
    const note = allNodes(container).find(node => props(node)?.role === "note")!;
    expect(props(note).id).toBe(props(button)["aria-controls"]);
    await act(async () => listeners.get("pointerdown")!({ target: note } as unknown as Event));
    expect(props(button)["aria-expanded"]).toBe(true);
    await act(async () => listeners.get("keydown")!({ key: "Escape", preventDefault() {} } as unknown as Event));
    expect(props(button)["aria-expanded"]).toBe(false);
    expect(focus).toHaveBeenCalledOnce();
    await act(async () => onClick(button)());
    await act(async () => listeners.get("pointerdown")!({ target: container } as unknown as Event));
    expect(container.textContent).not.toContain("只轉交近期文字對話");
  } finally { await act(async () => root.unmount()); }
  expect(listeners.has("keydown")).toBe(false);
  expect(listeners.has("pointerdown")).toBe(false);
});
