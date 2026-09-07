import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { AgentDefinition } from "../../app/useAgentSessions";
import {
  type SessionSidebarStatus,
} from "../../app/sessionStatus";
import { fuzzySearch } from "../../app/fuzzySearch";
import { displayPath } from "../../app/displayPath";
import {
  sessionSidebarDropPlacement,
  sessionSidebarChildren,
  type SessionSidebarFolder,
  type SessionSidebarLayout,
} from "../../app/sessionSidebarLayout";
import { useI18n } from "../../i18n/context";
import type { MessageKey } from "../../i18n/messages/zh-TW";
import {
  AgentIcon,
  ChevronDownIcon,
  CloseIcon,
  EditIcon,
  ExportIcon,
  FolderIcon,
  FolderOpenIcon,
  ImportIcon,
  MoreIcon,
  PlusIcon,
  ScreenShareIcon,
  SearchIcon,
  TerminalIcon,
  TransferIcon,
  TrashIcon,
} from "../icons";
import { handleMenuNavigation } from "../overlays/menuNavigation";
import { useModalFocus } from "../overlays/modalFocus";

export type SessionSidebarKind =
  | "agent"
  | "ssh"
  | "sftp"
  | "remote"
  | "rdp"
  | "vnc";

export interface SessionSidebarSessionItem {
  nodeId: string;
  sessionId: string;
  label: string;
  detail?: string;
  kind: SessionSidebarKind;
  status: SessionSidebarStatus;
  searchText?: string;
}

export interface SessionSidebarProjectItem {
  nodeId: string;
  projectId: string;
  label: string;
  workingDirectory: string | null;
  sessions: SessionSidebarSessionItem[];
}

interface FloatingLaunchMenu {
  projectNodeId: string;
  anchor: DOMRect;
}

interface SidebarSearchResult {
  id: string;
  kind: "project" | "session";
  label: string;
  hint: string;
  nodeId: string;
  sessionId: string;
  sessionKind?: SessionSidebarKind;
}

const TREE_DRAG_THRESHOLD = 5;
// Sentinel target id for the "move to top level" zone; real node ids always
// carry a folder:/session:/project prefix so this can never collide.
const TREE_ROOT_DROP = "__tree-root__";
// Sentinel launch-menu anchor for quick chats, which have no project row.
const QUICK_LAUNCH_NODE = "__quick-chat__";
const WORKSPACE_MANAGE_NODE = "__workspace-manage__";

const statusKeys: Record<Exclude<SessionSidebarStatus, "connected">, MessageKey> = {
  working: "terminal.projects.status.working",
  attention: "terminal.projects.status.attention",
  idle: "terminal.projects.status.idle",
  done: "terminal.projects.status.done",
};

function glyphFor(kind: SessionSidebarKind) {
  if (kind === "agent") return AgentIcon;
  if (kind === "sftp") return TransferIcon;
  if (kind === "ssh") return TerminalIcon;
  return ScreenShareIcon;
}

function treeStyle(depth: number): CSSProperties {
  return { "--session-tree-depth": depth } as CSSProperties;
}

export function SessionProjectSidebar({
  projects,
  layout,
  activeSessionId,
  choosingProject,
  chooseError,
  installedAgents,
  mobileOpen = false,
  onMobileClose,
  onChooseProject,
  onLaunchProject,
  onSelect,
  onRemove,
  onQuickLaunch,
  onExportWorkspace,
  onImportWorkspace,
  onClearWorkspace,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onToggleFolder,
  onRevealNode,
  onMove,
}: {
  projects: SessionSidebarProjectItem[];
  layout: SessionSidebarLayout;
  activeSessionId: string | null;
  choosingProject: boolean;
  chooseError: boolean;
  installedAgents: AgentDefinition[];
  mobileOpen?: boolean;
  onMobileClose: () => void;
  onChooseProject: () => void;
  onLaunchProject: (workingDirectory: string) => void;
  onSelect: (sessionId: string) => void;
  onRemove: (session: SessionSidebarSessionItem) => void;
  onQuickLaunch: (definition: AgentDefinition) => void;
  onExportWorkspace: () => void;
  onImportWorkspace: () => void;
  onClearWorkspace: () => void;
  onCreateFolder: (parentId: string | null) => void;
  onRenameFolder: (folder: SessionSidebarFolder) => void;
  onDeleteFolder: (folder: SessionSidebarFolder) => void;
  onToggleFolder: (folderId: string) => void;
  onRevealNode: (nodeId: string) => void;
  onMove: (
    nodeId: string,
    parentId: string | null,
    beforeNodeId?: string | null,
  ) => void;
}) {
  const { t } = useI18n();
  const folders = useMemo(
    () => new Map(layout.folders.map((folder) => [folder.id, folder])),
    [layout.folders],
  );
  const projectByNode = useMemo(
    () => new Map(projects.map((project) => [project.nodeId, project])),
    [projects],
  );
  const sessions = useMemo(
    () => projects.flatMap((project) => project.sessions),
    [projects],
  );
  const sessionByNode = useMemo(
    () => new Map(sessions.map((session) => [session.nodeId, session])),
    [sessions],
  );
  const [draggedNodeId, setDraggedNodeId] = useState<string | null>(null);
  const [dropTargetNodeId, setDropTargetNodeId] = useState<string | null>(null);
  const [launchMenu, setLaunchMenu] = useState<FloatingLaunchMenu | null>(null);
  const [movingSession, setMovingSession] =
    useState<SessionSidebarSessionItem | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [statusLegendOpen, setStatusLegendOpen] = useState(false);
  const [activeSearchResult, setActiveSearchResult] = useState(0);
  const launchMenuRef = useRef<HTMLElement>(null);
  const menuAnchorRef = useRef<HTMLButtonElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const moveDialogRef = useRef<HTMLDivElement>(null);
  const moveCancelRef = useRef<HTMLButtonElement>(null);

  useModalFocus({
    dialogRef: sidebarRef,
    getInitialFocus: () => searchInputRef.current,
    onEscape: () => {
      if (launchMenu) {
        setLaunchMenu(null);
        menuAnchorRef.current?.focus();
        return;
      }
      if (searchOpen) {
        setSearchOpen(false);
        searchInputRef.current?.focus();
        return;
      }
      onMobileClose();
    },
    active: mobileOpen,
  });
  useModalFocus({
    dialogRef: moveDialogRef,
    getInitialFocus: () => moveCancelRef.current,
    onEscape: () => setMovingSession(null),
    active: movingSession !== null,
  });

  const searchCandidates = useMemo(
    () =>
      projects.flatMap((project) => {
        const firstSession = project.sessions[0];
        const projectResult: SidebarSearchResult[] = firstSession
          ? [
              {
                id: `project:${project.projectId}`,
                kind: "project",
                label: project.label,
                hint: project.workingDirectory
                  ? displayPath(project.workingDirectory)
                  : project.label,
                nodeId: firstSession.nodeId,
                sessionId: firstSession.sessionId,
              },
            ]
          : [];
        const sessionResults = project.sessions.map<SidebarSearchResult>(
          (session) => ({
            id: `session:${session.sessionId}`,
            kind: "session",
            label: session.label,
            hint: project.label,
            nodeId: session.nodeId,
            sessionId: session.sessionId,
            sessionKind: session.kind,
          }),
        );
        return [
          ...projectResult.map((result) => ({
            value: result,
            texts: [
              project.label,
              project.workingDirectory ? displayPath(project.workingDirectory) : "",
            ],
          })),
          ...sessionResults.map((result, index) => ({
            value: result,
            texts: [
              result.label,
              project.sessions[index]?.searchText ?? "",
              project.label,
              project.workingDirectory ? displayPath(project.workingDirectory) : "",
            ],
          })),
        ];
      }),
    [projects],
  );
  const searchResults = useMemo(
    () => fuzzySearch(searchQuery, searchCandidates, 10),
    [searchCandidates, searchQuery],
  );

  useEffect(() => {
    setActiveSearchResult(0);
  }, [searchQuery]);

  useEffect(() => {
    setActiveSearchResult((current) =>
      Math.min(current, Math.max(0, searchResults.length - 1)),
    );
  }, [searchResults.length]);

  useEffect(() => {
    if (!launchMenu) return;
    const focusFrame = window.requestAnimationFrame(() => {
      const menu = launchMenuRef.current;
      const firstItem = menu?.querySelector<HTMLButtonElement>(
        'button[role="menuitem"]:not(:disabled)',
      );
      (firstItem ?? menu)?.focus();
    });
    function close(event: PointerEvent) {
      const target = event.target as Node | null;
      if (
        target &&
        (launchMenuRef.current?.contains(target) || menuAnchorRef.current?.contains(target))
      ) {
        return;
      }
      setLaunchMenu(null);
    }
    function reposition() {
      const anchor = menuAnchorRef.current;
      if (!anchor) {
        setLaunchMenu(null);
        return;
      }
      const bounds = anchor.getBoundingClientRect();
      setLaunchMenu((current) =>
        current ? { ...current, anchor: bounds } : null,
      );
    }
    document.addEventListener("pointerdown", close, true);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", close, true);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [launchMenu]);

  // A destination label spells out the whole branch so two folders or projects
  // sharing a name stay distinguishable in the move dialog.
  function destinationPath(nodeId: string, ownName: string) {
    const path = [ownName];
    const visited = new Set([nodeId]);
    let parentId = layout.placements[nodeId]?.parentId ?? null;
    while (parentId && !visited.has(parentId)) {
      const parent = folders.get(parentId);
      const parentName = parent?.name ?? projectByNode.get(parentId)?.label;
      if (!parentName) break;
      visited.add(parentId);
      path.unshift(parentName);
      parentId = layout.placements[parentId]?.parentId ?? null;
    }
    return path.join(" / ");
  }
  const folderDestinations = useMemo(
    () =>
      layout.folders
        .map((folder) => ({
          id: folder.id,
          label: destinationPath(folder.id, folder.name),
        }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    [folders, layout.folders, layout.placements, projectByNode],
  );
  // Projects own their sessions in the layout, so a session moved to the top
  // level needs a way back without dragging it there.
  const projectDestinations = useMemo(
    () =>
      projects
        .map((project) => ({
          id: project.nodeId,
          label: destinationPath(project.nodeId, project.label),
        }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    [folders, layout.placements, projects, projectByNode],
  );

  function nodeKind(nodeId: string): "folder" | "project" | "session" | null {
    if (folders.has(nodeId)) return "folder";
    if (projectByNode.has(nodeId)) return "project";
    if (sessionByNode.has(nodeId)) return "session";
    return null;
  }

  // HTML5 drag-and-drop never fires inside the Tauri webview on Windows while
  // the native drag handler (needed by the SFTP file drop) is enabled, so the
  // tree implements its own pointer-based drag. A small movement threshold
  // keeps plain clicks working.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const nodeKindRef = useRef(nodeKind);
  nodeKindRef.current = nodeKind;
  const dropRef = useRef<{ nodeId: string; after: boolean } | null>(null);
  const suppressClickRef = useRef(false);

  function pressNode(event: ReactPointerEvent<HTMLElement>, nodeId: string) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if ((event.target as HTMLElement | null)?.closest("[data-tree-action]")) {
      return;
    }
    const press = {
      nodeId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };

    const resetVisual = () => {
      dropRef.current = null;
      setDraggedNodeId(null);
      setDropTargetNodeId(null);
    };
    const teardown = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", cancel);
      document.removeEventListener("keydown", key, true);
    };
    const armClickSuppression = (untilNextPointerUp = false) => {
      suppressClickRef.current = true;
      const clear = () =>
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      if (untilNextPointerUp) {
        document.addEventListener("pointerup", clear, { once: true });
      } else {
        clear();
      }
    };

    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== press.pointerId) return;
      if (!press.active) {
        const distance = Math.hypot(
          moveEvent.clientX - press.startX,
          moveEvent.clientY - press.startY,
        );
        if (distance < TREE_DRAG_THRESHOLD) return;
        press.active = true;
        setDraggedNodeId(press.nodeId);
      }
      moveEvent.preventDefault();
      const hit = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
      if (hit?.closest("[data-tree-root-drop]")) {
        dropRef.current = { nodeId: TREE_ROOT_DROP, after: false };
        setDropTargetNodeId(TREE_ROOT_DROP);
        return;
      }
      const row = hit?.closest<HTMLElement>("[data-tree-node]");
      const targetNodeId = row?.dataset.treeNode;
      if (!row || !targetNodeId || targetNodeId === press.nodeId) {
        dropRef.current = null;
        setDropTargetNodeId(null);
        return;
      }
      const bounds = row.getBoundingClientRect();
      dropRef.current = {
        nodeId: targetNodeId,
        after: moveEvent.clientY > bounds.top + bounds.height / 2,
      };
      setDropTargetNodeId(targetNodeId);
    };

    const finish = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== press.pointerId) return;
      const drop = dropRef.current;
      teardown();
      resetVisual();
      if (!press.active) return;
      armClickSuppression();
      if (!drop) return;
      if (drop.nodeId === TREE_ROOT_DROP) {
        onMove(press.nodeId, null);
        return;
      }
      const targetKind = nodeKindRef.current(drop.nodeId);
      const sourceKind = nodeKindRef.current(press.nodeId);
      // A folder/project row is an explicit container target. Requiring the
      // pointer to hit only its lower half made ordinary drops look ignored.
      const targetIsContainer =
        targetKind === "folder" ||
        (targetKind === "project" && sourceKind === "session");
      const placement = sessionSidebarDropPlacement(
        layoutRef.current,
        press.nodeId,
        drop.nodeId,
        targetIsContainer,
        drop.after,
      );
      if (!placement) return;
      onMove(press.nodeId, placement.parentId, placement.beforeNodeId);
      // Projects are collapsible containers too, and a destination may itself
      // sit inside a collapsed branch, so reveal the whole chain rather than
      // toggling the drop target alone.
      if (placement.parentId) onRevealNode(press.nodeId);
    };

    const cancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId !== press.pointerId) return;
      teardown();
      if (press.active) armClickSuppression(true);
      resetVisual();
    };

    const key = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== "Escape") return;
      teardown();
      if (press.active) armClickSuppression(true);
      resetVisual();
    };

    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", cancel);
    document.addEventListener("keydown", key, true);
  }

  function openLaunchMenu(
    event: MouseEvent<HTMLButtonElement>,
    projectNodeId: string,
  ) {
    const button = event.currentTarget;
    const anchor = button.getBoundingClientRect();
    menuAnchorRef.current = button;
    setLaunchMenu((current) =>
      current?.projectNodeId === projectNodeId
        ? null
        : { projectNodeId, anchor },
    );
  }

  function statusMark(status: SessionSidebarStatus) {
    if (status === "connected") return null;
    const label = t(statusKeys[status]);
    return (
      <span
        className={`session-tree__status status-${status}`}
        title={label}
        aria-label={label}
      >
        <span aria-hidden="true" />
      </span>
    );
  }

  function selectSearchResult(result: SidebarSearchResult) {
    onRevealNode(result.nodeId);
    setSearchQuery("");
    setSearchOpen(false);
    onSelect(result.sessionId);
  }

  function handleSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSearchOpen(true);
      setActiveSearchResult((current) =>
        searchResults.length ? (current + 1) % searchResults.length : 0,
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSearchOpen(true);
      setActiveSearchResult((current) =>
        searchResults.length
          ? (current - 1 + searchResults.length) % searchResults.length
          : 0,
      );
    } else if (event.key === "Enter") {
      if (!searchOpen) {
        setSearchOpen(true);
        return;
      }
      const result = searchResults[activeSearchResult];
      if (!result) return;
      event.preventDefault();
      selectSearchResult(result);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setSearchOpen(false);
    }
  }

  function renderSession(session: SessionSidebarSessionItem, depth: number) {
    const Glyph = glyphFor(session.kind);
    return (
      <div
        role="listitem"
        className={`session-tree__session${
          session.sessionId === activeSessionId ? " is-active" : ""
        }${dropTargetNodeId === session.nodeId ? " is-drop-target" : ""}${
          draggedNodeId === session.nodeId ? " is-dragging" : ""
        }${session.status === "connected" ? "" : ` status-${session.status}`}`}
        style={treeStyle(depth)}
        key={session.nodeId}
        data-tree-node={session.nodeId}
        aria-grabbed={draggedNodeId === session.nodeId}
        onPointerDown={(event) => pressNode(event, session.nodeId)}
      >
        <button
          type="button"
          className="session-tree__session-select"
          onClick={() => onSelect(session.sessionId)}
          title={`${session.label} · ${t("terminal.projects.dragHint")}`}
        >
          <Glyph size={12} />
          <span className="session-tree__session-identity">
            <span className="truncate">{session.label}</span>
            {session.detail && (
              <span className="session-tree__session-detail truncate">
                {session.detail}
              </span>
            )}
          </span>
          {statusMark(session.status)}
        </button>
        <span className="session-tree__session-actions">
          <button
            type="button"
            className="icon-button icon-button--sm session-tree__session-move"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              setLaunchMenu(null);
              setMovingSession(session);
            }}
            aria-label={t("terminal.projects.sessionMoveFor", {
              name: session.label,
            })}
            title={t("terminal.projects.sessionMove")}
            data-tree-action="true"
          >
            <FolderIcon size={11} />
          </button>
          <button
            type="button"
            className="icon-button icon-button--sm icon-button--danger session-tree__session-remove"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onRemove(session);
            }}
            aria-label={t("terminal.projects.sessionRemoveFor", {
              name: session.label,
            })}
            title={t("terminal.projects.sessionRemove")}
            data-tree-action="true"
          >
            <TrashIcon size={11} />
          </button>
        </span>
      </div>
    );
  }

  function renderProject(project: SessionSidebarProjectItem, depth: number) {
    const selected = project.sessions.some(
      (session) => session.sessionId === activeSessionId,
    );
    // A project owns its sessions in the layout, so its rows are nested here
    // the same way a folder nests its children. Without this the sessions of a
    // project have nowhere to render, which also hides their remove button.
    const children = sessionSidebarChildren(layout, project.nodeId);
    const collapsed = layout.collapsedFolderIds.includes(project.nodeId);
    const expanded = children.length > 0 && !collapsed;
    const FolderGlyph = expanded ? FolderOpenIcon : FolderIcon;
    return (
      <div
        className="session-tree__project-branch"
        key={project.nodeId}
        role="listitem"
      >
        <div
          className={`session-tree__project${selected ? " is-active" : ""}${
            dropTargetNodeId === project.nodeId ? " is-drop-target" : ""
          }${draggedNodeId === project.nodeId ? " is-dragging" : ""}`}
          style={treeStyle(depth)}
          data-tree-node={project.nodeId}
          aria-grabbed={draggedNodeId === project.nodeId}
          onPointerDown={(event) => pressNode(event, project.nodeId)}
        >
          <button
            type="button"
            className="session-tree__project-select"
            onClick={() => onToggleFolder(project.nodeId)}
            title={
              project.workingDirectory
                ? displayPath(project.workingDirectory)
                : project.label
            }
            aria-expanded={expanded}
          >
            <FolderGlyph size={13} data-folder-state={expanded ? "open" : "closed"} />
            <span className="truncate">{project.label}</span>
          </button>
          {project.workingDirectory && (
            <button
              type="button"
              className="icon-button icon-button--sm"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onLaunchProject(project.workingDirectory!);
              }}
              aria-label={t("terminal.projects.newSession")}
              title={t("terminal.projects.newSession")}
              data-tree-action="true"
            >
              <PlusIcon size={11} />
            </button>
          )}
          {children.length > 0 && (
            <button
              type="button"
              className="icon-button icon-button--sm session-tree__branch-toggle"
              onClick={() => onToggleFolder(project.nodeId)}
              aria-label={t("terminal.projects.toggle")}
              aria-expanded={expanded}
              title={t("terminal.projects.toggle")}
              data-tree-action="true"
            >
              <ChevronDownIcon
                size={12}
                className={collapsed ? "is-collapsed" : undefined}
              />
            </button>
          )}
        </div>
        {!collapsed && children.length > 0 && (
          <div role="list">
            {children.map((id) => renderNode(id, depth + 1))}
          </div>
        )}
      </div>
    );
  }

  function renderFolder(folder: SessionSidebarFolder, depth: number) {
    const children = sessionSidebarChildren(layout, folder.id);
    const collapsed = layout.collapsedFolderIds.includes(folder.id);
    const expanded = children.length > 0 && !collapsed;
    const FolderGlyph = expanded ? FolderOpenIcon : FolderIcon;
    return (
      <div
        className="session-tree__folder"
        key={folder.id}
        role="listitem"
      >
        <div
          className={`session-tree__folder-row${
            dropTargetNodeId === folder.id ? " is-drop-target" : ""
          }${draggedNodeId === folder.id ? " is-dragging" : ""}`}
          style={treeStyle(depth)}
          data-tree-node={folder.id}
          aria-grabbed={draggedNodeId === folder.id}
          onPointerDown={(event) => pressNode(event, folder.id)}
        >
          <button
            type="button"
            className="session-tree__folder-select"
            onClick={() => onToggleFolder(folder.id)}
            title={`${folder.name} · ${t("terminal.projects.dragHint")}`}
            aria-expanded={expanded}
          >
            <FolderGlyph size={13} data-folder-state={expanded ? "open" : "closed"} />
            <span className="truncate">{folder.name}</span>
          </button>
          <button
            type="button"
            className="icon-button icon-button--sm session-tree__branch-toggle"
            onClick={() => onToggleFolder(folder.id)}
            aria-label={t("terminal.projects.toggle")}
            aria-expanded={expanded}
            title={t("terminal.projects.toggle")}
            data-tree-action="true"
          >
            <ChevronDownIcon size={12} className={collapsed ? "is-collapsed" : undefined} />
          </button>
          <div className="session-tree__folder-actions">
            <button
              type="button"
              className="icon-button icon-button--sm"
              onClick={() => onCreateFolder(folder.id)}
              aria-label={t("terminal.projects.addSubfolder")}
              title={t("terminal.projects.addSubfolder")}
              data-tree-action="true"
            >
              <PlusIcon size={11} />
            </button>
            <button
              type="button"
              className="icon-button icon-button--sm"
              onClick={() => onRenameFolder(folder)}
              aria-label={t("terminal.projects.folderRename")}
              title={t("terminal.projects.folderRename")}
              data-tree-action="true"
            >
              <EditIcon size={11} />
            </button>
            <button
              type="button"
              className="icon-button icon-button--sm icon-button--danger"
              onClick={() => onDeleteFolder(folder)}
              aria-label={t("terminal.projects.folderDelete")}
              title={t("terminal.projects.folderDelete")}
              data-tree-action="true"
            >
              <TrashIcon size={11} />
            </button>
          </div>
        </div>
        {expanded && (
          <div role="list">
            {children.map((id) => renderNode(id, depth + 1))}
          </div>
        )}
      </div>
    );
  }

  function renderNode(nodeId: string, depth: number): ReactNode {
    const folder = folders.get(nodeId);
    if (folder) return renderFolder(folder, depth);
    const project = projectByNode.get(nodeId);
    if (project) return renderProject(project, depth);
    const session = sessionByNode.get(nodeId);
    if (session) return renderSession(session, depth);
    return null;
  }

  const quickLaunchOpen = launchMenu?.projectNodeId === QUICK_LAUNCH_NODE;
  const workspaceManageOpen =
    launchMenu?.projectNodeId === WORKSPACE_MANAGE_NODE;
  const menuWidth = Math.min(240, Math.max(200, window.innerWidth - 24));
  const menuLeft = launchMenu
    ? launchMenu.anchor.right + 8 + menuWidth <= window.innerWidth
      ? launchMenu.anchor.right + 8
      : Math.max(12, launchMenu.anchor.left - menuWidth - 8)
    : 12;
  const menuTop = launchMenu
    ? Math.max(12, Math.min(launchMenu.anchor.top, window.innerHeight - 280))
    : 12;

  return (
    <aside
      ref={sidebarRef}
      id="session-project-sidebar"
      className={`session-projects${mobileOpen ? " is-mobile-open" : ""}`}
      aria-label={t("terminal.projects")}
      role={mobileOpen ? "dialog" : undefined}
      aria-modal={mobileOpen || undefined}
      tabIndex={mobileOpen ? -1 : undefined}
      onClickCapture={(event) => {
        // Swallow the click the browser synthesizes right after a drag ends.
        if (!suppressClickRef.current) return;
        suppressClickRef.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className="session-projects__header">
        <div className="session-projects__title">
          <FolderIcon size={14} />
          <span title={t("terminal.projects")}>{t("terminal.projects")}</span>
          <button
            type="button"
            className="icon-button icon-button--sm session-projects__status-help"
            onClick={() => setStatusLegendOpen((open) => !open)}
            aria-label={t("terminal.projects.statusGuide")}
            aria-expanded={statusLegendOpen}
            aria-controls="session-project-status-guide"
            title={t("terminal.projects.statusGuide")}
          >
            ?
          </button>
          <button
            type="button"
            className="icon-button icon-button--sm session-projects__folder-add"
            onClick={() => onCreateFolder(null)}
            aria-label={t("terminal.projects.addFolder")}
            title={t("terminal.projects.addFolder")}
          >
            <FolderIcon size={11} />
            <PlusIcon size={8} />
          </button>
          <button
            type="button"
            className="icon-button icon-button--sm"
            onClick={(event) => openLaunchMenu(event, WORKSPACE_MANAGE_NODE)}
            aria-label={t("terminal.projects.manage")}
            aria-haspopup="menu"
            aria-expanded={workspaceManageOpen}
            title={t("terminal.projects.manage")}
          >
            <MoreIcon size={12} />
          </button>
          <button
            type="button"
            className="icon-button icon-button--sm"
            onClick={(event) => openLaunchMenu(event, QUICK_LAUNCH_NODE)}
            aria-label={t("terminal.quickChat")}
            aria-haspopup="menu"
            aria-expanded={launchMenu?.projectNodeId === QUICK_LAUNCH_NODE}
            title={t("terminal.quickChat")}
          >
            <AgentIcon size={12} />
          </button>
          <button
            type="button"
            className="icon-button icon-button--sm"
            disabled={choosingProject}
            onClick={onChooseProject}
            aria-label={t("terminal.projects.add")}
            title={t("terminal.projects.add")}
          >
            <PlusIcon size={12} />
          </button>
        </div>
        {statusLegendOpen && (
          <section
            className="session-projects__status-guide"
            id="session-project-status-guide"
            aria-label={t("terminal.projects.statusGuide")}
          >
            <strong>{t("terminal.projects.statusGuide")}</strong>
            <span>
              <i className="status-working" aria-hidden="true" />
              {t("terminal.projects.statusGuideWorking")}
            </span>
            <span>
              <i className="status-attention" aria-hidden="true" />
              {t("terminal.projects.statusGuideAttention")}
            </span>
            <span>
              <i className="status-idle" aria-hidden="true" />
              {t("terminal.projects.statusGuideIdle")}
            </span>
            <span>
              <i className="status-done" aria-hidden="true" />
              {t("terminal.projects.statusGuideDone")}
            </span>
          </section>
        )}
      </div>
      {chooseError && (
        <div className="session-projects__error" role="alert">
          {t("terminal.projects.chooseFailed")}
        </div>
      )}
      <div
        className="session-projects__search"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setSearchOpen(false);
          }
        }}
      >
        <div className="session-projects__search-input">
          <SearchIcon size={13} aria-hidden="true" />
          <input
            ref={searchInputRef}
            type="search"
            role="combobox"
            value={searchQuery}
            placeholder={t("terminal.projects.searchPlaceholder")}
            aria-label={t("terminal.projects.searchPlaceholder")}
            aria-autocomplete="list"
            aria-expanded={searchOpen && searchQuery.trim().length > 0}
            aria-controls="session-project-search-results"
            aria-activedescendant={
              searchOpen && searchResults[activeSearchResult]
                ? `session-project-search-result-${activeSearchResult}`
                : undefined
            }
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            onFocus={() => {
              if (searchQuery.trim()) setSearchOpen(true);
            }}
            onChange={(event) => {
              setSearchQuery(event.currentTarget.value);
              setSearchOpen(true);
            }}
            onKeyDown={handleSearchKeyDown}
          />
          {searchQuery && (
            <button
              type="button"
              className="session-projects__search-clear"
              aria-label={t("terminal.projects.searchClear")}
              onClick={() => {
                setSearchQuery("");
                setSearchOpen(false);
                searchInputRef.current?.focus();
              }}
            >
              <CloseIcon size={10} />
            </button>
          )}
        </div>
        {searchOpen && searchQuery.trim() && (
          <div
            className="session-projects__search-results"
            id="session-project-search-results"
            role="listbox"
          >
            {searchResults.length === 0 ? (
              <p>{t("terminal.projects.searchEmpty", { query: searchQuery })}</p>
            ) : (
              searchResults.map((result, index) => {
                const Glyph =
                  result.kind === "project"
                    ? FolderIcon
                    : glyphFor(result.sessionKind ?? "agent");
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === activeSearchResult}
                    id={`session-project-search-result-${index}`}
                    className={index === activeSearchResult ? "is-active" : ""}
                    key={result.id}
                    onMouseEnter={() => setActiveSearchResult(index)}
                    onClick={() => selectSearchResult(result)}
                  >
                    <Glyph size={12} />
                    <span>
                      <strong className="truncate">{result.label}</strong>
                      <small className="truncate">{result.hint}</small>
                    </span>
                    <em>
                      {t(
                        result.kind === "project"
                          ? "terminal.projects.searchKindProject"
                          : "terminal.projects.searchKindSession",
                      )}
                    </em>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>
      <div
        className={`session-tree${draggedNodeId ? " is-dragging" : ""}`}
        role="list"
        aria-label={t("terminal.projects")}
      >
        {sessionSidebarChildren(layout, null).map((id) => renderNode(id, 0))}
        <div
          className={`session-tree__root-drop${draggedNodeId ? " is-visible" : ""}${
            dropTargetNodeId === TREE_ROOT_DROP ? " is-drop-target" : ""
          }`}
          data-tree-root-drop="true"
          role="presentation"
          aria-hidden="true"
        >
          {t("terminal.projects.moveToRoot")}
        </div>
      </div>

      {quickLaunchOpen &&
        createPortal(
          <section
            ref={launchMenuRef}
            className="session-launch-menu"
            style={{ left: menuLeft, top: menuTop, width: menuWidth }}
            role="menu"
            aria-label={t("terminal.quickChat")}
            tabIndex={-1}
            onKeyDown={(event) =>
              handleMenuNavigation(event, () => {
                setLaunchMenu(null);
                menuAnchorRef.current?.focus();
              })
            }
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                setLaunchMenu(null);
              }
            }}
          >
            <header>
              <span className="eyebrow">{t("terminal.quickChat")}</span>
              <strong className="truncate">{t("terminal.quickChat.hint")}</strong>
            </header>
            <div className="session-launch-menu__list">
              {installedAgents.map((definition) => (
                <button
                  type="button"
                  role="menuitem"
                  className="button button--ghost button--sm"
                  key={definition.id}
                  onClick={() => {
                    setLaunchMenu(null);
                    onQuickLaunch(definition);
                  }}
                >
                  <AgentIcon size={11} />
                  {definition.label}
                </button>
              ))}
              {installedAgents.length === 0 && (
                <small>{t("terminal.addCli.none")}</small>
              )}
            </div>
          </section>,
          document.body,
        )}
      {workspaceManageOpen &&
        createPortal(
          <section
            ref={launchMenuRef}
            className="session-launch-menu"
            style={{ left: menuLeft, top: menuTop, width: menuWidth }}
            role="menu"
            aria-label={t("terminal.projects.manage")}
            tabIndex={-1}
            onKeyDown={(event) =>
              handleMenuNavigation(event, () => {
                setLaunchMenu(null);
                menuAnchorRef.current?.focus();
              })
            }
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                setLaunchMenu(null);
              }
            }}
          >
            <header>
              <span className="eyebrow">{t("terminal.projects")}</span>
              <strong>{t("terminal.projects.manage")}</strong>
            </header>
            <div className="session-launch-menu__list">
              <button
                type="button"
                role="menuitem"
                className="button button--ghost button--sm"
                onClick={() => {
                  setLaunchMenu(null);
                  onExportWorkspace();
                }}
              >
                <ExportIcon size={12} />
                {t("terminal.projects.export")}
              </button>
              <button
                type="button"
                role="menuitem"
                className="button button--ghost button--sm"
                onClick={() => {
                  setLaunchMenu(null);
                  onImportWorkspace();
                }}
              >
                <ImportIcon size={12} />
                {t("terminal.projects.import")}
              </button>
              <button
                type="button"
                role="menuitem"
                className="button button--ghost button--sm button--danger"
                onClick={() => {
                  setLaunchMenu(null);
                  onClearWorkspace();
                }}
              >
                <TrashIcon size={12} />
                {t("terminal.projects.clear")}
              </button>
            </div>
          </section>,
          document.body,
        )}
      {movingSession &&
        createPortal(
          <div
            className="scrim scrim--center"
            role="presentation"
            onMouseDown={() => setMovingSession(null)}
          >
            <div
              ref={moveDialogRef}
              className="dialog session-move-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="session-move-title"
              tabIndex={-1}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <header className="dialog__head">
                <span
                  className="dialog__icon dialog__icon--inline"
                  aria-hidden="true"
                >
                  <FolderIcon size={17} />
                </span>
                <h2 className="dialog__title" id="session-move-title">
                  {t("terminal.projects.sessionMoveTitle", {
                    name: movingSession.label,
                  })}
                </h2>
              </header>
              <div className="dialog__stack">
                <p className="dialog__body">
                  {t("terminal.projects.sessionMoveBody")}
                </p>
                <div className="session-move-dialog__destinations">
                  {[
                    {
                      id: null,
                      label: t("terminal.projects.sessionMoveRoot"),
                    },
                    ...projectDestinations,
                    ...folderDestinations,
                  ].map((destination) => {
                    const currentParentId =
                      layout.placements[movingSession.nodeId]?.parentId ?? null;
                    const current = currentParentId === destination.id;
                    return (
                      <button
                        type="button"
                        className="session-move-dialog__destination"
                        key={destination.id ?? "root"}
                        disabled={current}
                        onClick={() => {
                          onMove(movingSession.nodeId, destination.id);
                          if (destination.id) onRevealNode(movingSession.nodeId);
                          setMovingSession(null);
                        }}
                      >
                        <FolderIcon size={13} />
                        <span className="truncate">{destination.label}</span>
                        {current && (
                          <small>{t("terminal.projects.sessionMoveCurrent")}</small>
                        )}
                      </button>
                    );
                  })}
                </div>
                {folderDestinations.length === 0 && (
                  <p className="dialog__body dialog__body--muted">
                    {t("terminal.projects.sessionMoveNoFolders")}
                  </p>
                )}
                <div className="dialog__actions">
                  <button
                    ref={moveCancelRef}
                    type="button"
                    className="button button--ghost"
                    onClick={() => setMovingSession(null)}
                  >
                    {t("common.cancel")}
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </aside>
  );
}
