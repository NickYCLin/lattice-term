import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { allNodes, HostNode, installHostDom, props } from "../agents/testFixtures/interactionDom";
import { createSessionSidebarFolder, emptySessionSidebarLayout, moveSessionSidebarNode, reconcileSessionSidebarLayout, sessionSidebarChildren, type SessionSidebarLayout } from "../../app/sessionSidebarLayout";
import { readSharedSidebarLayout, SHARED_SIDEBAR_LAYOUT_KEY, updateSharedSidebarLayout } from "../../app/sharedSidebarLayout";
import { installFakeStorage } from "../../app/testFixtures/agentApis";
import { I18nProvider } from "../../i18n";
import { SessionProjectSidebar, type SessionSidebarProjectItem } from "./SessionProjectSidebar";
vi.mock("../overlays/modalFocus", () => ({ useModalFocus: () => {} }));
let host: HostNode; let root: ReturnType<typeof createRoot>; let cleanup: () => void;
let layout: SessionSidebarLayout;
const listeners = new Map<string, Set<(event: any) => void>>();
const remote = "project:remote-connections";
const projects: SessionSidebarProjectItem[] = [{ nodeId: remote, projectId: "remote-connections", label: "遠端連線", workingDirectory: null,
  sessions: [{ nodeId: "session:ssh:fixture", sessionId: "ssh-fixture", label: "合成工作階段", kind: "ssh", detail: "", status: "connected" }] }];
const live = [{ id: remote, defaultParentId: null }, { id: "session:ssh:fixture", defaultParentId: remote }];
const actions = { onCreateFolder: vi.fn(), onRenameFolder: vi.fn(), onDeleteFolder: vi.fn(), onRemoveProject: vi.fn(), onRevealNode: vi.fn(), onMove: vi.fn() };
function render() {
  root.render(<I18nProvider locale="zh-TW"><SessionProjectSidebar projects={projects} layout={layout} activeSessionId={null} choosingProject={false} chooseError={false}
    onMobileClose={() => {}} onChooseProject={() => {}} onLaunchProject={() => {}} onSelect={() => {}} onRemove={() => {}} onQuickLaunch={() => {}}
    onExportWorkspace={() => {}} onImportWorkspace={() => {}} onClearWorkspace={() => {}} onToggleFolder={() => {}} {...actions} /></I18nProvider>);
}
const row = (id: string) => allNodes(host).find(node => node.attributes["data-tree-node"] === id)!;
async function dispatch(name: string, event: any) { await act(async () => { for (const callback of [...listeners.get(name) ?? []]) callback(event); }); }
beforeEach(async () => {
  cleanup = installFakeStorage(); host = installHostDom(); root = createRoot(host as unknown as Element); listeners.clear();
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((...args) => Object.assign(createElement(...args), { style: { setProperty() {} } }));
  vi.stubGlobal("Node", HostNode); Object.assign(window, { innerWidth: 1200, innerHeight: 800 });
  Object.assign(HostNode.prototype, {
    getBoundingClientRect() { return { top: 100, bottom: 140, left: 100, height: 40 }; },
    querySelectorAll(this: HostNode) { return allNodes(this).filter(node => props(node)?.role === "menuitem" && !props(node)?.disabled); },
    querySelector(this: HostNode) { return allNodes(this).find(node => props(node)?.role === "menuitem" && !props(node)?.disabled) ?? null; },
    contains(this: HostNode, node: HostNode) { return allNodes(this).includes(node); },
    focus(this: HostNode) { Object.assign(document, { activeElement: this }); },
  });
  document.addEventListener = ((name: string, callback: any) => { const list = listeners.get(name) ?? new Set(); list.add(callback); listeners.set(name, list); }) as typeof document.addEventListener;
  document.removeEventListener = ((name: string, callback: any) => listeners.get(name)?.delete(callback)) as typeof document.removeEventListener;
  layout = reconcileSessionSidebarLayout(emptySessionSidebarLayout, live);
  layout = createSessionSidebarFolder(layout, { id: "folder:a", name: "航空城" }, null);
  layout = createSessionSidebarFolder(layout, { id: "folder:b", name: "桃源水情" }, null);
  localStorage.setItem(SHARED_SIDEBAR_LAYOUT_KEY, JSON.stringify(layout)); readSharedSidebarLayout();
  for (const callback of Object.values(actions)) callback.mockReset();
  actions.onMove.mockImplementation((nodeId, parentId, beforeNodeId) => { layout = moveSessionSidebarNode(layout, nodeId, parentId, beforeNodeId); updateSharedSidebarLayout(layout); render(); });
  await act(async () => render());
});
afterEach(async () => { await act(async () => root.unmount()); cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function drag(source: string, target: string, y: number) {
  await act(async () => props(row(source)).onPointerDown({ pointerType: "mouse", button: 0, pointerId: 1, clientX: 0, clientY: 0, target: { closest: () => null } }));
  const targetRow = row(target); Object.assign(targetRow, { dataset: { treeNode: target } });
  document.elementFromPoint = (() => ({ closest: (selector: string) => selector === "[data-tree-node]" ? targetRow : null })) as unknown as typeof document.elementFromPoint;
  await dispatch("pointermove", { pointerId: 1, clientX: 20, clientY: y, preventDefault() {} });
}
it("draws a sibling insertion line for a folder middle drop and persists the reordered layout", async () => {
  await drag("folder:b", "folder:a", 119);
  expect(props(row("folder:a")).className).toContain("is-drop-before");
  expect(props(row("folder:a")).className).not.toContain("is-drop-target");
  await dispatch("pointerup", { pointerId: 1 });
  expect(actions.onMove).toHaveBeenCalledWith("folder:b", null, "folder:a");
  const loaded = reconcileSessionSidebarLayout(JSON.parse(localStorage.getItem(SHARED_SIDEBAR_LAYOUT_KEY)!), live);
  expect(sessionSidebarChildren(loaded, null)).toEqual([remote, "folder:b", "folder:a"]);
  expect(loaded.placements["folder:b"].parentId).toBeNull();
});
it("retains middle-into-folder for sessions and treats remote-connections as an insertion reference", async () => {
  await drag("session:ssh:fixture", "folder:a", 120);
  expect(props(row("folder:a")).className).toContain("is-drop-target");
  await dispatch("pointerup", { pointerId: 1 }); expect(actions.onMove).toHaveBeenLastCalledWith("session:ssh:fixture", "folder:a", null);
  expect(actions.onRevealNode).toHaveBeenCalledWith("session:ssh:fixture");
  await drag("folder:b", remote, 101);
  await dispatch("pointerup", { pointerId: 1 }); expect(actions.onMove).toHaveBeenLastCalledWith("folder:b", null, remote);
  expect(row(remote).textContent).not.toContain("調整");
  expect(allNodes(row(remote)).some(node => props(node)?.["aria-label"] === "重新命名資料夾")).toBe(false);
  expect(actions.onRenameFolder).not.toHaveBeenCalled(); expect(actions.onDeleteFolder).not.toHaveBeenCalled(); expect(actions.onRemoveProject).not.toHaveBeenCalled();
});
it("offers keyboard menu movement, disabled endpoints, Escape and outside dismissal", async () => {
  const toggle = () => allNodes(host).find(node => props(node)?.["aria-label"] === "調整「桃源水情」的順序" && node.tagName === "BUTTON")!;
  await act(async () => props(toggle()).onClick());
  expect(props(toggle()).title).toBeUndefined();
  expect(props(allNodes(row("folder:b")).find(node => props(node)?.className === "session-tree__folder-select")!).title).toBeUndefined();
  const menu = () => allNodes(host).find(node => props(node)?.role === "menu")!;
  const items = () => allNodes(menu()).filter(node => props(node)?.role === "menuitem");
  expect(props(items()[1]).disabled).toBe(true); expect(document.activeElement).toBe(items()[0]);
  await act(async () => props(items()[0]).onClick());
  expect(actions.onMove).toHaveBeenLastCalledWith("folder:b", null, "folder:a");
  expect(props(document.activeElement as unknown as HostNode).className).toBe("session-tree__folder-select");
  await act(async () => props(toggle()).onClick());
  const event = (key: string) => ({ key, currentTarget: menu(), preventDefault: vi.fn(), stopPropagation: vi.fn() });
  await act(async () => props(menu()).onKeyDown(event("ArrowDown"))); expect(document.activeElement).toBe(items()[1]);
  await act(async () => props(menu()).onKeyDown(event("ArrowUp"))); expect(document.activeElement).toBe(items()[0]);
  await act(async () => props(menu()).onKeyDown(event("End"))); expect(document.activeElement).toBe(items()[1]);
  await act(async () => props(menu()).onKeyDown(event("Home"))); expect(document.activeElement).toBe(items()[0]);
  await act(async () => props(menu()).onKeyDown(event("Escape"))); expect(menu()).toBeUndefined(); expect(document.activeElement).toBe(toggle());
  await act(async () => props(toggle()).onClick()); await dispatch("pointerdown", { target: host }); expect(menu()).toBeUndefined();
  await act(async () => actions.onMove("folder:b", null, remote));
  await act(async () => props(toggle()).onClick());
  expect(props(items()[0]).disabled).toBe(true); expect(props(items()[1]).disabled).toBe(false);
  const calls = actions.onMove.mock.calls.length;
  await act(async () => props(items()[0]).onClick()); expect(actions.onMove).toHaveBeenCalledTimes(calls);
});

it("moves nested folders outward with the menu or root blank area and persists the new parent", async () => {
  layout = createSessionSidebarFolder(layout, { id: "folder:child", name: "Synthetic Child" }, "folder:a");
  await act(async () => render());
  const toggle = () => allNodes(host).find(node => props(node)?.["aria-label"] === "調整「Synthetic Child」的順序" && node.tagName === "BUTTON")!;
  await act(async () => props(toggle()).onClick());
  const parent = allNodes(host).find(node => props(node)?.role === "menuitem" && node.textContent.includes("移到上一層"))!;
  expect(props(parent).disabled).toBe(false);
  await act(async () => props(parent).onClick());
  expect(actions.onMove).toHaveBeenLastCalledWith("folder:child", null, "folder:b");
  expect(props(document.activeElement as unknown as HostNode).className).toBe("session-tree__folder-select");
  expect(JSON.parse(localStorage.getItem(SHARED_SIDEBAR_LAYOUT_KEY)!).placements["folder:child"].parentId).toBeNull();
  for (const area of ["tree", "sidebar"]) {
    layout = moveSessionSidebarNode(layout, "folder:child", "folder:a"); await act(async () => render());
    await act(async () => props(row("folder:child")).onPointerDown({ pointerType: "mouse", button: 0, pointerId: 2, clientX: 0, clientY: 0, target: { closest: () => null } }));
    const blank = allNodes(host).find(node => area === "tree" ? props(node)?.className === "session-tree" : props(node)?.id === "session-project-sidebar")!;
    document.elementFromPoint = (() => blank) as unknown as typeof document.elementFromPoint;
    await dispatch("pointermove", { pointerId: 2, clientX: 20, clientY: 200, preventDefault() {} });
    await dispatch("pointerup", { pointerId: 2 });
    expect(actions.onMove).toHaveBeenLastCalledWith("folder:child", null);
    expect(JSON.parse(localStorage.getItem(SHARED_SIDEBAR_LAYOUT_KEY)!).placements["folder:child"].parentId).toBeNull();
  }
});
