/**
 * The thread list as a tree of folders.
 *
 * Rows can be dragged with the pointer: onto a folder to file the node
 * inside, onto the upper or lower half of another row to reorder next to
 * it, or onto the empty space below to move it back to the top level. A
 * short press without movement is an ordinary click. The tree runs its own
 * pointer-based drag because HTML drag events are unreliable in the
 * WebViews LatticeTerm ships in.
 */

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { ChatThread } from "../../app/agentChat";
import {
  chatSidebarRows,
  type ChatSidebarRow,
  type ChatSidebarWorkspace,
} from "../../app/chatThreadLayout";
import {
  sessionSidebarDropPlacement,
  type SessionSidebarLayout,
} from "../../app/sessionSidebarLayout";
import { useI18n } from "../../i18n/context";
import { ConfirmDialog } from "../overlays/ConfirmDialog";
import { AgentIcon, ChevronRightIcon, FolderIcon, PlusIcon, TrashIcon } from "../icons";

const DRAG_THRESHOLD_PX = 6;

interface DropTarget {
  nodeId: string | null;
  mode: "into" | "before" | "after";
}

export function ChatThreadTree({
  layout,
  threads,
  activeThreadId,
  renderThread,
  workspace,
  onSelectThread,
  onOpenSession,
  onRemoveThread,
  onToggleFolder,
  onRenameFolder,
  onRemoveFolder,
  onCreateFolder,
  onMoveNode,
}: {
  layout: SessionSidebarLayout;
  threads: readonly ChatThread[];
  activeThreadId: string | null;
  renderThread: (thread: ChatThread, active: boolean) => React.ReactNode;
  workspace?: ChatSidebarWorkspace;
  onSelectThread: (threadId: string) => void;
  onOpenSession?: (sessionId: string) => void;
  onRemoveThread: (thread: ChatThread) => void;
  onToggleFolder: (folderId: string) => void;
  onRenameFolder: (folderId: string, name: string) => void;
  onRemoveFolder: (folderId: string) => void;
  onCreateFolder: (name: string, parentId: string | null) => void;
  onMoveNode: (nodeId: string, parentId: string | null, beforeNodeId: string | null) => void;
}) {
  const { t } = useI18n();
  const rows = chatSidebarRows(layout, threads, workspace);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [subfolderParent, setSubfolderParent] = useState<string | null | undefined>(undefined);
  const [subfolderName, setSubfolderName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<ChatSidebarRow | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const press = useRef<{
    nodeId: string;
    pointerId: number;
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);
  const dropRef = useRef<DropTarget | null>(null);
  dropRef.current = dropTarget;

  const isFolder = (nodeId: string) =>
    layout.folders.some((folder) => folder.id === nodeId) || (workspace?.projects.has(nodeId) ?? false);

  function targetAt(x: number, y: number): DropTarget | null {
    const element = document.elementFromPoint(x, y);
    const row = element?.closest<HTMLElement>("[data-node-id]");
    if (!row) {
      return listRef.current?.contains(element) ? { nodeId: null, mode: "into" } : null;
    }
    const nodeId = row.dataset.nodeId!;
    const rect = row.getBoundingClientRect();
    const fraction = (y - rect.top) / Math.max(rect.height, 1);
    if (isFolder(nodeId)) {
      // The middle of a folder files the node inside; its edges reorder
      // next to it, so a folder can still be placed among its siblings.
      if (fraction < 0.25) return { nodeId, mode: "before" };
      if (fraction > 0.75) return { nodeId, mode: "after" };
      return { nodeId, mode: "into" };
    }
    return { nodeId, mode: fraction < 0.5 ? "before" : "after" };
  }

  function onPointerDown(event: ReactPointerEvent, nodeId: string) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if ((event.target as HTMLElement).closest("input, .chat-tree__action")) return;
    press.current = {
      nodeId,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moved: false,
    };
  }

  useEffect(() => {
    function move(event: PointerEvent) {
      const current = press.current;
      if (!current || event.pointerId !== current.pointerId) return;
      if (!current.moved) {
        if (
          Math.abs(event.clientX - current.x) < DRAG_THRESHOLD_PX &&
          Math.abs(event.clientY - current.y) < DRAG_THRESHOLD_PX
        ) {
          return;
        }
        current.moved = true;
        setDragging(current.nodeId);
      }
      event.preventDefault();
      const target = targetAt(event.clientX, event.clientY);
      setDropTarget(target && target.nodeId !== current.nodeId ? target : null);
    }
    function finish(event: PointerEvent) {
      const current = press.current;
      if (!current || event.pointerId !== current.pointerId) return;
      press.current = null;
      const target = dropRef.current;
      setDragging(null);
      setDropTarget(null);
      if (!current.moved || !target) return;
      if (target.nodeId === null) {
        onMoveNode(current.nodeId, null, null);
        return;
      }
      const placement = sessionSidebarDropPlacement(
        layout,
        current.nodeId,
        target.nodeId,
        target.mode === "into",
        target.mode === "after",
      );
      if (placement) onMoveNode(current.nodeId, placement.parentId, placement.beforeNodeId);
    }
    function cancel() {
      press.current = null;
      setDragging(null);
      setDropTarget(null);
    }
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", cancel);
    return () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", cancel);
    };
  });

  function dropClass(nodeId: string | null): string {
    if (!dropTarget || dropTarget.nodeId !== nodeId) return "";
    return ` is-drop-${dropTarget.mode}`;
  }

  function submitSubfolder() {
    const name = subfolderName.trim();
    if (name && subfolderParent !== undefined) onCreateFolder(name, subfolderParent);
    setSubfolderParent(undefined);
    setSubfolderName("");
  }

  return (
    <div className="chat-tree" ref={listRef}>
      {rows.map((row) => {
        const indent = { paddingLeft: `${row.depth * 0.9}rem` };
        if (row.kind === "folder" || row.kind === "project") {
          // Everything filed directly in the branch counts, sessions included.
          const count = Object.entries(layout.placements).filter(
            ([nodeId, placement]) =>
              placement.parentId === row.nodeId &&
              (threads.some((thread) => `thread:${thread.id}` === nodeId) ||
                (workspace?.sessions.has(nodeId) ?? false)),
          ).length;
          const editable = row.kind === "folder";
          return (
            <div key={row.nodeId}>
              <div
                className={`chat-tree__row${dragging === row.nodeId ? " is-dragging" : ""}${dropClass(row.nodeId)}`}
                style={indent}
                data-node-id={row.nodeId}
                onPointerDown={(event) => onPointerDown(event, row.nodeId)}
              >
                {editable && renaming?.id === row.nodeId ? (
                  <form
                    className="chat-folder-form"
                    style={{ padding: 0, flex: 1 }}
                    onSubmit={(event) => {
                      event.preventDefault();
                      const name = renaming.name.trim();
                      if (name) onRenameFolder(row.nodeId, name);
                      setRenaming(null);
                    }}
                  >
                    <input
                      className="input"
                      autoFocus
                      value={renaming.name}
                      aria-label={t("chat.folder.rename")}
                      onChange={(event) => setRenaming({ id: row.nodeId, name: event.target.value })}
                      onBlur={() => setRenaming(null)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") setRenaming(null);
                      }}
                    />
                  </form>
                ) : (
                  <>
                    <button
                      type="button"
                      className={`chat-folder${editable ? "" : " chat-folder--project"}`}
                      onClick={() => onToggleFolder(row.nodeId)}
                      onDoubleClick={() => {
                        if (editable) setRenaming({ id: row.nodeId, name: row.name });
                      }}
                      aria-expanded={!row.collapsed}
                      title={row.collapsed ? t("chat.folder.expand") : t("chat.folder.collapse")}
                    >
                      <ChevronRightIcon
                        className={`chat-folder__chevron${row.collapsed ? "" : " is-open"}`}
                      />
                      <FolderIcon />
                      <span className="chat-folder__name">{row.name}</span>
                      {count > 0 && <span className="chat-folder__count">{count}</span>}
                    </button>
                    {editable && <span className="chat-tree__actions">
                      <button
                        type="button"
                        className="chat-tree__action"
                        onClick={() => {
                          setSubfolderParent(row.nodeId);
                          setSubfolderName("");
                        }}
                        aria-label={t("chat.folder.subfolder")}
                        title={t("chat.folder.subfolder")}
                      >
                        <PlusIcon />
                      </button>
                      <button
                        type="button"
                        className="chat-tree__action"
                        onClick={() => setPendingDelete(row)}
                        aria-label={t("chat.folder.delete")}
                        title={t("chat.folder.delete")}
                      >
                        <TrashIcon />
                      </button>
                    </span>}
                  </>
                )}
              </div>
              {subfolderParent === row.nodeId && (
                <form
                  className="chat-folder-form"
                  style={{ paddingLeft: `${(row.depth + 1) * 0.9 + 0.5}rem` }}
                  onSubmit={(event) => {
                    event.preventDefault();
                    submitSubfolder();
                  }}
                >
                  <input
                    className="input"
                    autoFocus
                    value={subfolderName}
                    placeholder={t("chat.folder.name.placeholder")}
                    aria-label={t("chat.folder.name.placeholder")}
                    onChange={(event) => setSubfolderName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setSubfolderParent(undefined);
                    }}
                  />
                  <button type="submit" className="button button--primary button--sm">
                    {t("chat.folder.create")}
                  </button>
                </form>
              )}
              {!row.collapsed && row.empty && (
                <p className="chat-tree__empty" style={{ paddingLeft: `${(row.depth + 1) * 0.9 + 0.75}rem` }}>
                  {t("chat.folder.empty")}
                </p>
              )}
            </div>
          );
        }
        if (row.kind === "session") {
          return (
            <div
              key={row.nodeId}
              className={`chat-tree__row${dragging === row.nodeId ? " is-dragging" : ""}${dropClass(row.nodeId)}`}
              style={indent}
              data-node-id={row.nodeId}
              onPointerDown={(event) => onPointerDown(event, row.nodeId)}
              onClick={() => {
                if (!press.current?.moved) onOpenSession?.(row.session.sessionId);
              }}
            >
              <div
                className={`chat-session is-${row.session.status}`}
                role="button"
                tabIndex={0}
                title={row.session.label}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onOpenSession?.(row.session.sessionId);
                  }
                }}
              >
                <AgentIcon size={13} />
                <span className="chat-session__label">
                  <span className="chat-thread__title">{row.session.label}</span>
                  <span className="chat-thread__meta">
                    {row.session.detail ?? t("terminal.title")}
                  </span>
                </span>
                <span className="chat-session__status" aria-hidden="true" />
              </div>
            </div>
          );
        }
        return (
          <div
            key={row.nodeId}
            className={`chat-tree__row${dragging === row.nodeId ? " is-dragging" : ""}${dropClass(row.nodeId)}`}
            style={indent}
            data-node-id={row.nodeId}
            onPointerDown={(event) => onPointerDown(event, row.nodeId)}
            onClick={() => {
              if (!press.current?.moved) onSelectThread(row.thread.id);
            }}
          >
            {renderThread(row.thread, row.thread.id === activeThreadId)}
            <span className="chat-tree__actions">
              <button
                type="button"
                className="chat-tree__action chat-tree__action--danger"
                onClick={(event) => {
                  event.stopPropagation();
                  onRemoveThread(row.thread);
                }}
                aria-label={`${t("chat.delete")}：${row.thread.title || t("chat.untitled")}`}
                title={t("chat.delete")}
              >
                <TrashIcon />
              </button>
            </span>
          </div>
        );
      })}
      <div className={`chat-tree__root-drop${dragging ? dropClass(null) : ""}`} aria-hidden="true" />
      {pendingDelete && pendingDelete.kind === "folder" && (
        <ConfirmDialog
          title={t("chat.folder.delete.title", { name: pendingDelete.name })}
          body={t("chat.folder.delete.body")}
          confirmLabel={t("chat.folder.delete.action")}
          tone="danger"
          onConfirm={() => {
            onRemoveFolder(pendingDelete.nodeId);
            setPendingDelete(null);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
