import { describe, expect, it } from "vitest";
import {
  createSessionSidebarFolder,
  emptySessionSidebarLayout,
  expandSessionSidebarAncestors,
  moveSessionSidebarNode,
  reconcileSessionSidebarLayout,
  removeSessionSidebarFolder,
  sanitizeSessionSidebarLayout,
  sessionSidebarChildren,
  sessionSidebarDropPlacement,
  sessionSidebarSessionNodeId,
  toggleSessionSidebarFolder,
} from "./sessionSidebarLayout";

const project = { id: "project:local:latticeterm", defaultParentId: null };
const session = {
  id: "session:agent:latticeterm",
  defaultParentId: project.id,
};

describe("session sidebar layout", () => {
  it("does not add a folder beyond the total node limit", () => {
    const layout = {
      ...emptySessionSidebarLayout,
      placements: Object.fromEntries(Array.from({ length: 1024 }, (_, index) =>
        [`thread:${index}`, { parentId: null, order: index }])),
    };
    expect(sanitizeSessionSidebarLayout(layout)).not.toBeNull();
    const next = createSessionSidebarFolder(layout, { id: "folder:overflow", name: "額外資料夾" }, null);
    expect(sanitizeSessionSidebarLayout(next)).not.toBeNull();
    expect(next).toBe(layout);
  });
  it("places new sessions below their discovered project", () => {
    const layout = reconcileSessionSidebarLayout(emptySessionSidebarLayout, [
      project,
      session,
    ]);

    expect(sessionSidebarChildren(layout, null)).toEqual([project.id]);
    expect(sessionSidebarChildren(layout, project.id)).toEqual([session.id]);
  });

  it("keeps an explicit top-level move instead of restoring the default parent", () => {
    let layout = reconcileSessionSidebarLayout(emptySessionSidebarLayout, [
      project,
      session,
    ]);
    layout = moveSessionSidebarNode(layout, session.id, null);

    layout = reconcileSessionSidebarLayout(layout, [project, session]);

    expect(sessionSidebarChildren(layout, null)).toEqual([
      project.id,
      session.id,
    ]);
    expect(sessionSidebarChildren(layout, project.id)).toEqual([]);
  });

  it("keeps restored session placement while its CLI is starting", () => {
    let layout = reconcileSessionSidebarLayout(emptySessionSidebarLayout, [
      project,
      session,
    ]);
    layout = createSessionSidebarFolder(
      layout,
      { id: "folder:water", name: "水情" },
      null,
    );
    layout = moveSessionSidebarNode(layout, project.id, "folder:water");

    const duringRestore = reconcileSessionSidebarLayout(layout, [], [
      project,
      session,
    ]);

    expect(sessionSidebarChildren(duringRestore, null)).toEqual([
      "folder:water",
    ]);
    expect(sessionSidebarChildren(duringRestore, "folder:water")).toEqual([
      project.id,
    ]);
    expect(sessionSidebarChildren(duringRestore, project.id)).toEqual([
      session.id,
    ]);
  });

  it("uses saved profile identity across remote-session reconnects", () => {
    expect(
      sessionSidebarSessionNodeId("ssh", "runtime-before", "profile:server"),
    ).toBe(
      sessionSidebarSessionNodeId("ssh", "runtime-after", "profile:server"),
    );
    expect(sessionSidebarSessionNodeId("ssh", "runtime-only", null)).toBe(
      "session:ssh:runtime-only",
    );
  });

  it("supports nested custom folders and moving live nodes", () => {
    let layout = reconcileSessionSidebarLayout(emptySessionSidebarLayout, [
      project,
      session,
    ]);
    layout = createSessionSidebarFolder(
      layout,
      { id: "folder:work", name: "工作" },
      null,
    );
    layout = createSessionSidebarFolder(
      layout,
      { id: "folder:active", name: "進行中" },
      "folder:work",
    );
    layout = moveSessionSidebarNode(layout, project.id, "folder:active");
    layout = moveSessionSidebarNode(layout, session.id, "folder:active");

    expect(sessionSidebarChildren(layout, null)).toEqual(["folder:work"]);
    expect(sessionSidebarChildren(layout, "folder:work")).toEqual([
      "folder:active",
    ]);
    expect(sessionSidebarChildren(layout, "folder:active")).toEqual([
      project.id,
      session.id,
    ]);
  });

  it("drops project rows into the requested folder", () => {
    let layout = reconcileSessionSidebarLayout(emptySessionSidebarLayout, [
      project,
      session,
    ]);
    layout = createSessionSidebarFolder(
      layout,
      { id: "folder:work", name: "工作" },
      null,
    );

    const destination = sessionSidebarDropPlacement(
      layout,
      project.id,
      "folder:work",
      true,
      false,
    );
    expect(destination).toEqual({
      parentId: "folder:work",
      beforeNodeId: null,
    });

    layout = moveSessionSidebarNode(
      layout,
      project.id,
      destination!.parentId,
      destination!.beforeNodeId,
    );
    expect(sessionSidebarChildren(layout, "folder:work")).toEqual([
      project.id,
    ]);
  });

  it("reorders ordinary rows at the exact drop edge", () => {
    const secondProject = { id: "project:local:mysqlpunk", defaultParentId: null };
    const thirdProject = { id: "project:local:mqttape", defaultParentId: null };
    let layout = reconcileSessionSidebarLayout(emptySessionSidebarLayout, [
      project,
      secondProject,
      thirdProject,
    ]);

    const destination = sessionSidebarDropPlacement(
      layout,
      thirdProject.id,
      project.id,
      false,
      true,
    );
    expect(destination).toEqual({
      parentId: null,
      beforeNodeId: secondProject.id,
    });

    layout = moveSessionSidebarNode(
      layout,
      thirdProject.id,
      destination!.parentId,
      destination!.beforeNodeId,
    );
    expect(sessionSidebarChildren(layout, null)).toEqual([
      project.id,
      thirdProject.id,
      secondProject.id,
    ]);
  });

  it("rejects cycles when a folder is moved into its descendant", () => {
    let layout = createSessionSidebarFolder(
      emptySessionSidebarLayout,
      { id: "folder:parent", name: "父層" },
      null,
    );
    layout = createSessionSidebarFolder(
      layout,
      { id: "folder:child", name: "子層" },
      "folder:parent",
    );

    const rejected = moveSessionSidebarNode(
      layout,
      "folder:parent",
      "folder:child",
    );

    expect(rejected).toEqual(layout);
  });

  it("moves a removed folder's children to its parent", () => {
    let layout = reconcileSessionSidebarLayout(emptySessionSidebarLayout, [project]);
    layout = createSessionSidebarFolder(
      layout,
      { id: "folder:work", name: "工作" },
      null,
    );
    layout = moveSessionSidebarNode(layout, project.id, "folder:work");

    layout = removeSessionSidebarFolder(layout, "folder:work");

    expect(sessionSidebarChildren(layout, null)).toEqual([project.id]);
  });

  it("keeps a live project branch collapsed across reconciliation", () => {
    let layout = reconcileSessionSidebarLayout(emptySessionSidebarLayout, [
      project,
      session,
    ]);
    layout = toggleSessionSidebarFolder(layout, project.id);

    expect(layout.collapsedFolderIds).toEqual([project.id]);
    expect(
      reconcileSessionSidebarLayout(layout, [project, session]).collapsedFolderIds,
    ).toEqual([project.id]);
    expect(reconcileSessionSidebarLayout(layout, []).collapsedFolderIds).toEqual([]);
  });

  it("reveals a node by expanding every collapsed ancestor", () => {
    let layout = reconcileSessionSidebarLayout(emptySessionSidebarLayout, [
      project,
      session,
    ]);
    layout = createSessionSidebarFolder(
      layout,
      { id: "folder:work", name: "工作" },
      null,
    );
    layout = moveSessionSidebarNode(layout, project.id, "folder:work");
    layout = toggleSessionSidebarFolder(layout, "folder:work");
    layout = toggleSessionSidebarFolder(layout, project.id);

    const revealed = expandSessionSidebarAncestors(layout, session.id);

    expect(revealed.collapsedFolderIds).toEqual([]);
    // The node itself keeps its own collapsed state; only the path is opened.
    expect(
      expandSessionSidebarAncestors(revealed, session.id),
    ).toBe(revealed);
  });

  it("keeps a drop into a collapsed branch and reveals it in one sequence", () => {
    const otherProject = {
      id: "project:local:mysqlpunk",
      defaultParentId: null,
    };
    let layout = reconcileSessionSidebarLayout(emptySessionSidebarLayout, [
      project,
      session,
      otherProject,
    ]);
    layout = toggleSessionSidebarFolder(layout, otherProject.id);

    layout = moveSessionSidebarNode(layout, session.id, otherProject.id);
    layout = expandSessionSidebarAncestors(layout, session.id);

    expect(sessionSidebarChildren(layout, otherProject.id)).toEqual([
      session.id,
    ]);
    expect(layout.collapsedFolderIds).toEqual([]);
  });

  it("fails closed for malformed or oversized persisted data", () => {
    expect(sanitizeSessionSidebarLayout({ version: 1 })).toBeNull();
    expect(
      sanitizeSessionSidebarLayout({
        version: 1,
        folders: [{ id: "bad", name: "Bad" }],
        placements: {},
        collapsedFolderIds: [],
      }),
    ).toBeNull();
  });
});
