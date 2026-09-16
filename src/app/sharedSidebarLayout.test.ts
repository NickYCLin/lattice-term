import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createThread } from "./agentChat";
import { chatSidebarRows, reconcileChatLayout } from "./chatThreadLayout";
import {
  createSessionSidebarFolder, emptySessionSidebarLayout, moveSessionSidebarNode,
  removeSessionSidebarFolder, renameSessionSidebarFolder, sanitizeSessionSidebarLayout,
  SESSION_SIDEBAR_LAYOUT_KEY, toggleSessionSidebarFolder, type SessionSidebarLayout,
} from "./sessionSidebarLayout";
import {
  migrateSidebarLayouts, readSharedSidebarLayout, reconcileSharedSessionLayout,
  SHARED_SIDEBAR_LAYOUT_KEY, subscribeSharedSidebarLayout, updateSharedSidebarLayout,
} from "./sharedSidebarLayout";

const thread = createThread({ definitionId: "claude", workingDirectory: "/fixture", permission: "ask", model: "" }, "one", 1);
let stored: Map<string, string>;
let fixtureRevision = 0;
beforeEach(() => {
  // A new durable revision distinguishes a fresh fixture from unsaved memory
  // retained after the preceding test's simulated quota failure.
  stored = new Map([[SHARED_SIDEBAR_LAYOUT_KEY, JSON.stringify({ ...emptySessionSidebarLayout, fixtureRevision: ++fixtureRevision })]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  readSharedSidebarLayout();
});
afterEach(() => vi.unstubAllGlobals());

describe("shared sidebar folders", () => {
  it("migrates both trees without losing colliding folder IDs or nested placements", () => {
    const sessions = createSessionSidebarFolder(emptySessionSidebarLayout, { id: "folder:one", name: "工作" }, null);
    let chat = createSessionSidebarFolder(reconcileChatLayout(emptySessionSidebarLayout, [thread]), { id: "folder:one", name: "對話" }, null);
    chat = createSessionSidebarFolder(chat, { id: "folder:child", name: "子資料夾" }, "folder:one");
    chat = moveSessionSidebarNode(chat, "thread:one", "folder:child");
    chat = toggleSessionSidebarFolder(chat, "folder:one");
    const next = migrateSidebarLayouts(sessions, chat);
    const migrated = next.folders.find(folder => folder.name === "對話")!.id;
    expect(migrated).not.toBe("folder:one");
    expect(next.placements["folder:child"].parentId).toBe(migrated);
    expect(next.placements["thread:one"].parentId).toBe("folder:child");
    expect(next.collapsedFolderIds).toContain(migrated);
    expect(sanitizeSessionSidebarLayout(next)).toEqual(next);
  });

  it("keeps both legacy sources and persists edits only in the shared source", () => {
    stored.delete(SHARED_SIDEBAR_LAYOUT_KEY);
    const old = JSON.stringify(createSessionSidebarFolder(emptySessionSidebarLayout, { id: "folder:legacy", name: "舊資料" }, null));
    stored.set(SESSION_SIDEBAR_LAYOUT_KEY, old);
    stored.set("latticeterm.chatSidebar.v1", JSON.stringify(reconcileChatLayout(emptySessionSidebarLayout, [thread])));
    expect(readSharedSidebarLayout().folders[0].name).toBe("舊資料");
    updateSharedSidebarLayout(current => renameSessionSidebarFolder(current, "folder:legacy", "共用"));
    expect(stored.get(SESSION_SIDEBAR_LAYOUT_KEY)).toBe(old);
    expect(JSON.parse(stored.get(SHARED_SIDEBAR_LAYOUT_KEY)!).folders[0].name).toBe("共用");
    expect(readSharedSidebarLayout().placements["thread:one"]).toBeDefined();
  });

  it("notifies both consumers and applies consecutive edits to the latest state", () => {
    const sessions = vi.fn();
    const chat = vi.fn();
    const stopSessions = subscribeSharedSidebarLayout(sessions);
    const stopChat = subscribeSharedSidebarLayout(chat);
    try {
      updateSharedSidebarLayout(current => createSessionSidebarFolder(current, { id: "folder:shared", name: "專案" }, null));
      updateSharedSidebarLayout(current => renameSessionSidebarFolder(current, "folder:shared", "更名"));
      updateSharedSidebarLayout(current => toggleSessionSidebarFolder(current, "folder:shared"));
      expect(readSharedSidebarLayout().folders[0].name).toBe("更名");
      expect(readSharedSidebarLayout().collapsedFolderIds).toEqual(["folder:shared"]);
      expect(sessions).toHaveBeenCalledTimes(3);
      expect(chat).toHaveBeenCalledTimes(3);
    } finally { stopSessions(); stopChat(); }
  });

  it("preserves the other view's leaves and reparents both when deleting a folder", () => {
    let layout = createSessionSidebarFolder(emptySessionSidebarLayout, { id: "folder:shared", name: "專案" }, null);
    layout = reconcileSharedSessionLayout(layout, [{ id: "session:one", defaultParentId: "folder:shared" }]);
    layout = moveSessionSidebarNode(reconcileChatLayout(layout, [thread]), "thread:one", "folder:shared");
    layout = reconcileSharedSessionLayout(layout, [{ id: "session:one", defaultParentId: null }]);
    expect(layout.placements["thread:one"].parentId).toBe("folder:shared");
    expect(reconcileChatLayout(layout, []).placements["session:one"].parentId).toBe("folder:shared");
    layout = removeSessionSidebarFolder(layout, "folder:shared");
    expect(layout.placements["thread:one"].parentId).toBeNull();
    expect(layout.placements["session:one"].parentId).toBeNull();
  });

  it("shows custom folders nested under a session project in the chat tree", () => {
    let layout = reconcileSharedSessionLayout(emptySessionSidebarLayout, [{ id: "project:one", defaultParentId: null }]);
    layout = createSessionSidebarFolder(layout, { id: "folder:inside", name: "共用" }, "project:one");
    layout = moveSessionSidebarNode(reconcileChatLayout(layout, [thread]), "thread:one", "folder:inside");
    expect(chatSidebarRows(layout, [thread]).map(row => row.nodeId)).toEqual(["folder:inside", "thread:one"]);
  });

  it("retains both old trees at their previous size limits", () => {
    const full = (prefix: string): SessionSidebarLayout => ({ version: 1,
      folders: Array.from({ length: 64 }, (_, index) => ({ id: `folder:${prefix}${index}`, name: "資料夾" })),
      placements: Object.fromEntries(Array.from({ length: 512 }, (_, index) => [`${index < 64 ? "folder" : "session"}:${prefix}${index}`, { parentId: null, order: index }])),
      collapsedFolderIds: [],
    });
    const merged = migrateSidebarLayouts(full("a"), full("b"));
    expect(merged.folders).toHaveLength(128);
    expect(Object.keys(merged.placements)).toHaveLength(1024);
    expect(sanitizeSessionSidebarLayout(merged)).not.toBeNull();
  });

  it("reads an external window update before applying the next edit", () => {
    const events = new EventTarget();
    vi.stubGlobal("window", events);
    const notify = vi.fn();
    const stop = subscribeSharedSidebarLayout(notify);
    try {
      const external = createSessionSidebarFolder(emptySessionSidebarLayout, { id: "folder:external", name: "另一個視窗" }, null);
      stored.set(SHARED_SIDEBAR_LAYOUT_KEY, JSON.stringify(external));
      events.dispatchEvent(new Event("storage"));
      expect(notify).toHaveBeenCalledOnce();
      updateSharedSidebarLayout(current => renameSessionSidebarFolder(current, "folder:external", "已同步"));
      expect(readSharedSidebarLayout().folders[0].name).toBe("已同步");
    } finally { stop(); }
  });

  it("keeps a storage failure from interrupting chat or overwriting the durable layout", () => {
    const durable = stored.get(SHARED_SIDEBAR_LAYOUT_KEY);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: () => { throw new Error("quota"); },
    });
    expect(() => updateSharedSidebarLayout(current => createSessionSidebarFolder(current, { id: "folder:memory", name: "暫存" }, null))).not.toThrow();
    expect(readSharedSidebarLayout().folders[0].name).toBe("暫存");
    expect(stored.get(SHARED_SIDEBAR_LAYOUT_KEY)).toBe(durable);
  });

  it.each(["{broken", JSON.stringify({ version: 2 })])("does not overwrite an unreadable shared source: %s", raw => {
    updateSharedSidebarLayout(current => createSessionSidebarFolder(current, { id: "folder:kept", name: "保留" }, null));
    stored.set(SHARED_SIDEBAR_LAYOUT_KEY, raw);
    expect(readSharedSidebarLayout().folders[0]?.name).toBe("保留");
    updateSharedSidebarLayout(current => renameSessionSidebarFolder(current, "folder:kept", "暫存修改"));
    expect(stored.get(SHARED_SIDEBAR_LAYOUT_KEY)).toBe(raw);
  });

  it("retries an unsaved layout when the next reconciliation has no changes", () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: () => { throw new Error("quota"); },
    });
    updateSharedSidebarLayout(current => createSessionSidebarFolder(current, { id: "folder:retry", name: "待保存" }, null));
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    });
    updateSharedSidebarLayout(current => current);
    expect(JSON.parse(stored.get(SHARED_SIDEBAR_LAYOUT_KEY)!).folders[0]?.name).toBe("待保存");
  });

  it("does not persist a layout that cannot be loaded again", () => {
    const durable = stored.get(SHARED_SIDEBAR_LAYOUT_KEY);
    updateSharedSidebarLayout(current => ({ ...current, placements: Object.fromEntries(
      Array.from({ length: 1025 }, (_, index) => [`thread:${index}`, { parentId: null, order: 0 }]),
    ) }));
    expect(stored.get(SHARED_SIDEBAR_LAYOUT_KEY)).toBe(durable);
  });
});
