import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { allNodes, installHostDom, props, HostNode } from "../agents/testFixtures/interactionDom";
import { createConnectionProfile, emptyDraft } from "../../domain/connection";
import { I18nProvider } from "../../i18n";
import { ConnectionCard } from "./ConnectionCard";

let container: HostNode;
let root: ReturnType<typeof createRoot>;
let bounds = { top: 100, bottom: 130, right: 300 };
const listeners = new Map<string, Set<(event: unknown) => void>>();
const actions = {
  onSelect: vi.fn(), onEdit: vi.fn(), onDuplicate: vi.fn(), onDelete: vi.fn(),
  onToggleFavorite: vi.fn(), onAddRoute: vi.fn(), onMerge: vi.fn(), onDatabases: vi.fn(),
};
function menu() { return allNodes(container).find(node => props(node)?.role === "menu"); }
function toggle() { return allNodes(container).find(node => props(node)?.["aria-haspopup"] === "menu")!; }
function items() { return allNodes(menu()!).filter(node => props(node)?.role === "menuitem"); }
async function click(node: HostNode) { await act(async () => props(node).onClick()); }
async function key(node: HostNode, value: string) {
  const event = { key: value, currentTarget: node, preventDefault: vi.fn(), stopPropagation: vi.fn() };
  await act(async () => props(node).onKeyDown(event));
  return event;
}
async function dispatch(name: string, event: unknown = {}) {
  await act(async () => { for (const callback of [...listeners.get(name) ?? []]) callback(event); });
}
beforeEach(async () => {
  container = installHostDom();
  root = createRoot(container as unknown as Element);
  vi.clearAllMocks(); listeners.clear();
  bounds = { top: 100, bottom: 130, right: 300 };
  Object.assign(window, { innerWidth: 800, innerHeight: 600 });
  for (const target of [document, window]) {
    target.addEventListener = ((name: string, callback: (event: unknown) => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(callback);
    }) as typeof target.addEventListener;
    target.removeEventListener = ((name: string, callback: (event: unknown) => void) => listeners.get(name)?.delete(callback)) as typeof target.removeEventListener;
  }
  Object.defineProperties(HostNode.prototype, {
    getBoundingClientRect: { configurable: true, value: () => bounds },
    scrollHeight: { configurable: true, get: () => 250 },
    contains: { configurable: true, value: function(this: HostNode, target: HostNode) { return allNodes(this).includes(target); } },
    querySelectorAll: { configurable: true, value: function(this: HostNode) { return allNodes(this).filter(node => props(node)?.role === "menuitem"); } },
  });
  vi.spyOn(HostNode.prototype, "focus").mockImplementation(function(this: HostNode) {
    Object.assign(document, { activeElement: this });
  });
  await act(async () => root.render(<I18nProvider locale="zh-TW">
    <ConnectionCard profile={createConnectionProfile({ ...emptyDraft(), name: "主機", hostname: "host.example.com" }, "card")}
      selected={false} {...actions} />
  </I18nProvider>));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  for (const property of ["getBoundingClientRect", "scrollHeight", "contains", "querySelectorAll"]) Reflect.deleteProperty(HostNode.prototype, property);
  vi.unstubAllGlobals();
});

it("toggles a labelled menu outside the card and places it below the trigger", async () => {
  expect(menu()).toBeUndefined();
  expect(props(toggle())["aria-expanded"]).toBe(false);
  await click(toggle());
  expect(props(toggle())["aria-controls"]).toBe(props(menu()!).id);
  expect(props(menu()!).style).toMatchObject({ left: 60, top: 136, width: 240 });
  const card = allNodes(container).find(node => node.tagName === "LI")!;
  expect(allNodes(card).some(node => node === menu())).toBe(false);
  expect(menu()!.parentNode === container).toBe(true);
  expect(document.activeElement).toBe(items()[0]);
  await click(toggle());
  expect(menu()).toBeUndefined();
  expect(document.activeElement).toBe(toggle());
});

it.each(["onEdit", "onDuplicate", "onDelete", "onAddRoute", "onMerge", "onDatabases"] as const)("closes and restores focus before %s", async action => {
  await click(toggle());
  const index = { onAddRoute: 0, onMerge: 1, onDatabases: 2, onEdit: 3, onDuplicate: 4, onDelete: 5 }[action];
  actions[action].mockImplementation(() => {
    expect(menu()).toBeUndefined();
    expect(document.activeElement).toBe(toggle());
  });
  await click(items()[index]);
  expect(actions[action]).toHaveBeenCalledOnce();
  expect(actions.onSelect).not.toHaveBeenCalled();
});

it("handles Escape and outside clicks, but keeps inside clicks open", async () => {
  await click(toggle());
  await dispatch("click", { target: items()[0] });
  expect(menu()).toBeDefined();
  const event = await key(menu()!, "Escape");
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(event.stopPropagation).toHaveBeenCalledOnce();
  expect(menu()).toBeUndefined();
  expect(document.activeElement).toBe(toggle());
  await click(toggle());
  await dispatch("click", { target: container });
  expect(menu()).toBeUndefined();
  expect(document.activeElement).toBe(toggle());
});

it("navigates with arrows, Home and End and opens at either end from the trigger", async () => {
  await key(toggle(), "ArrowUp");
  expect(document.activeElement).toBe(items()[5]);
  await key(menu()!, "ArrowDown");
  expect(document.activeElement).toBe(items()[0]);
  await key(menu()!, "ArrowUp");
  expect(document.activeElement).toBe(items()[5]);
  await key(menu()!, "Home");
  expect(document.activeElement).toBe(items()[0]);
  await key(menu()!, "End");
  expect(document.activeElement).toBe(items()[5]);
  await key(menu()!, "Escape");
  await key(toggle(), "ArrowDown");
  expect(document.activeElement).toBe(items()[0]);
  const tab = await key(menu()!, "Tab");
  expect(tab.preventDefault).not.toHaveBeenCalled();
  expect(menu()).toBeUndefined();
});

it("repositions at viewport edges and removes listeners on close", async () => {
  bounds = { top: 530, bottom: 560, right: 790 };
  await click(toggle());
  expect(props(menu()!).style).toMatchObject({ top: 274, left: 550 });
  Object.assign(window, { innerWidth: 200 });
  await dispatch("resize");
  expect(props(menu()!).style).toMatchObject({ left: 8, width: 184 });
  bounds = { top: 120, bottom: 150, right: 180 };
  await dispatch("scroll");
  expect(props(menu()!).style.top).toBe(156);
  await click(toggle());
  expect(listeners.get("resize")?.size).toBe(0);
  expect(listeners.get("scroll")?.size).toBe(0);
});

it("keeps only supported optional actions and stops positioning after unmount", async () => {
  await act(async () => root.render(<I18nProvider locale="zh-TW"><ConnectionCard
    profile={createConnectionProfile({ ...emptyDraft(), name: "主機", hostname: "host.example.com" }, "card")}
    selected={false} onSelect={actions.onSelect} onEdit={actions.onEdit} onDuplicate={actions.onDuplicate}
    onDelete={actions.onDelete} onToggleFavorite={actions.onToggleFavorite} /></I18nProvider>));
  await click(toggle());
  expect(items().map(node => node.textContent)).toEqual(["編輯", "複製一份", "刪除"]);
  expect(props(items()[2]).className).toBe("connection-card__delete");
  await act(async () => root.render(null));
  expect(listeners.get("resize")?.size).toBe(0);
  expect(listeners.get("scroll")?.size).toBe(0);
  expect(listeners.get("click")?.size).toBe(0);
});
