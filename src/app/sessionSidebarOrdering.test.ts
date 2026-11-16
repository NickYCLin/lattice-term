import { afterEach, expect, it, vi } from "vitest";
import { createSessionSidebarFolder, emptySessionSidebarLayout, moveSessionSidebarNode, reconcileSessionSidebarLayout, sessionSidebarChildren,
  sessionSidebarDropIntent, sessionSidebarDropPlacement, sessionSidebarStepPlacement, sanitizeSessionSidebarLayout } from "./sessionSidebarLayout";
import { readSharedSidebarLayout, updateSharedSidebarLayout, SHARED_SIDEBAR_LAYOUT_KEY } from "./sharedSidebarLayout";
const remote = { id: "project:remote-connections", defaultParentId: null };
const project = { id: "project:local:fixture", defaultParentId: null };
const session = { id: "session:ssh:fixture", defaultParentId: remote.id };
function fixture() {
  let layout = reconcileSessionSidebarLayout(emptySessionSidebarLayout, [remote, project, session]);
  for (const [id, name] of [["folder:a", "航空城"], ["folder:b", "桃源水情"]]) layout = createSessionSidebarFolder(layout, { id, name }, null);
  return layout;
}
afterEach(() => vi.unstubAllGlobals());
it.each([0.1, 0.49, 0.5, 0.9])("folder-to-folder drops at %s reorder siblings, including the middle", ratio => {
  const layout = fixture(); const intent = sessionSidebarDropIntent("folder", "folder", ratio);
  expect(intent).not.toBe("into");
  const destination = sessionSidebarDropPlacement(layout, "folder:b", "folder:a", intent === "into", intent === "after")!;
  const moved = moveSessionSidebarNode(layout, "folder:b", destination.parentId, destination.beforeNodeId);
  expect(moved.placements["folder:b"].parentId).toBeNull();
  const ids = sessionSidebarChildren(moved, null);
  expect(ids.indexOf("folder:b") - ids.indexOf("folder:a")).toBe(intent === "before" ? -1 : 1);
  // Defensive core check: callers cannot accidentally request nesting folders.
  expect(sessionSidebarDropPlacement(layout, "folder:b", "folder:a", true, ratio >= 0.5)?.parentId).toBeNull();
});
it.each(["session", "project"] as const)("preserves %s middle-into-folder and edge ordering", source => {
  const layout = fixture(); const id = source === "session" ? session.id : project.id;
  expect(sessionSidebarDropIntent(source, "folder", 0.5)).toBe("into");
  expect(sessionSidebarDropPlacement(layout, id, "folder:a", true, false)).toEqual({ parentId: "folder:a", beforeNodeId: null });
  expect(sessionSidebarDropIntent(source, "folder", 0.1)).toBe("before");
  expect(sessionSidebarDropIntent(source, "folder", 0.9)).toBe("after");
  expect(sessionSidebarDropIntent("session", "project", 0.5)).toBe("into");
});
it("uses remote-connections as an ordinary insertion reference and persists order through reconcile", () => {
  let layout = fixture(); const before = sessionSidebarDropPlacement(layout, "folder:b", remote.id, false, false)!;
  layout = moveSessionSidebarNode(layout, "folder:b", before.parentId, before.beforeNodeId);
  expect(sessionSidebarChildren(layout, null)[0]).toBe("folder:b");
  const values = new Map([[SHARED_SIDEBAR_LAYOUT_KEY, JSON.stringify(fixture())]]);
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  readSharedSidebarLayout(); updateSharedSidebarLayout(layout);
  const reloaded = sanitizeSessionSidebarLayout(JSON.parse(values.get(SHARED_SIDEBAR_LAYOUT_KEY)!))!;
  const reconciled = reconcileSessionSidebarLayout(reloaded, [remote, project, session]);
  expect(sessionSidebarChildren(reconciled, null)).toEqual(sessionSidebarChildren(layout, null));
  expect(reconciled.folders.map(folder => folder.id)).not.toContain(remote.id);
});
it("menu step movement matches drops and disables endpoints within the current parent", () => {
  let layout = fixture(); const top = sessionSidebarChildren(layout, null)[0];
  expect(sessionSidebarStepPlacement(layout, top, "up")).toBeNull();
  expect(sessionSidebarStepPlacement(layout, "folder:b", "down")).toBeNull();
  const step = sessionSidebarStepPlacement(layout, "folder:b", "up")!;
  expect(step).toEqual(sessionSidebarDropPlacement(layout, "folder:b", "folder:a", false, false));
  layout = moveSessionSidebarNode(layout, "folder:b", step.parentId, step.beforeNodeId);
  expect(sessionSidebarChildren(layout, null).slice(-2)).toEqual(["folder:b", "folder:a"]);
  const back = sessionSidebarStepPlacement(layout, "folder:b", "down")!;
  layout = moveSessionSidebarNode(layout, "folder:b", back.parentId, back.beforeNodeId);
  expect(sessionSidebarChildren(layout, null).slice(-2)).toEqual(["folder:a", "folder:b"]);
  layout = createSessionSidebarFolder(layout, { id: "folder:child", name: "子資料夾" }, "folder:a");
  expect(sessionSidebarDropPlacement(layout, "folder:b", "folder:child", false, false)).toBeNull();
});
