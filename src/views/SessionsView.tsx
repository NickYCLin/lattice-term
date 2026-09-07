/** Unified workspace for text terminals and graphical remote sessions. */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { downloadDir, homeDir, join } from "@tauri-apps/api/path";
import type { RemoteApi } from "../app/useRemoteSessions";
import type { RdpApi } from "../app/useRdpSessions";
import type { VncApi } from "../app/useVncSessions";
import {
  isSuccessfulProcessExit,
  shouldClearSessionSelection,
  type SessionClosedNotice,
} from "../app/sessionSnapshot";
import type {
  AgentApi,
  AgentDefinition,
  AgentSessionSummary,
} from "../app/useAgentSessions";
import { agentCatalogForDisplay } from "../app/useAgentSessions";
import {
  accountModelKey,
  accountModelLaunchSettings,
  accountModelOptions,
  accountModelTargets,
  accountSessionLabel,
  type AccountModelSelection,
} from "../app/accountModels";
import { useAccountModels } from "../app/useAccountModels";
import { useAccountProfileStatus } from "../app/useAccountProfileStatus";
import { useChatAccountProfiles } from "../app/useChatAccountProfiles";
import { AccountModelField } from "../components/agents/AccountModelField";
import { displayPath } from "../app/displayPath";
import type { SshApi } from "../app/useSshSessions";
import type { SftpApi } from "../app/useSftpSessions";
import type { ThemeId } from "../app/themes";
import {
  savedAgentWorkingDirectories,
  type SavedWorkspaceSession,
} from "../app/workspaceSessionPersistence";
import { agentGroupSidebarStatus } from "../app/sessionStatus";
import {
  agentSessionSidebarMemberNodeId,
  presentAgentSessionGroup,
} from "../app/agentSessionPresentation";
import { disconnectAgentSessionMembers } from "../app/agentSessionRemoval";
import {
  relocateAgentSessionGroup,
  summarizeAgentRelocation,
} from "../app/agentSessionRelocation";
import {
  createSessionSidebarFolder,
  emptySessionSidebarLayout,
  expandSessionSidebarAncestors,
  loadSessionSidebarLayout,
  mergeSessionSidebarLayouts,
  moveSessionSidebarNode,
  reconcileSessionSidebarLayout,
  removeSessionSidebarFolder,
  renameSessionSidebarFolder,
  saveSessionSidebarLayout,
  sessionSidebarSessionNodeId,
  toggleSessionSidebarFolder,
  type LiveSessionSidebarNode,
  type SessionSidebarFolder,
  type SessionSidebarLayout,
} from "../app/sessionSidebarLayout";
import {
  MAX_WORKSPACE_TRANSFER_BYTES,
  parseWorkspaceTransfer,
  serializeWorkspaceTransfer,
  type PortableWorkspaceItem,
  type WorkspaceTransferFile,
} from "../app/workspaceTransfer";
import { useI18n } from "../i18n/context";
import { Callout, EmptyState } from "../components/common/Callout";
import { ConfirmDialog } from "../components/overlays/ConfirmDialog";
import {
  SessionProjectSidebar,
  type SessionSidebarProjectItem,
  type SessionSidebarSessionItem,
} from "../components/sessions/SessionProjectSidebar";
import { AgentSessionRelocationDialog } from "../components/sessions/AgentSessionRelocationDialog";
import { WorkspaceImportDialog } from "../components/sessions/WorkspaceImportDialog";
import {
  AgentIcon,
  CloseIcon,
  EditIcon,
  FolderIcon,
  ImportIcon,
  PlusIcon,
  ScreenShareIcon,
  TerminalIcon,
  TransferIcon,
} from "../components/icons";
import { AgentTerminalPane } from "../components/agents/AgentTerminalPane";
import { HostMetricsPanel } from "../components/connections/HostMetricsPanel";
import { useSessionHostMetrics } from "../app/useHostMetrics";
import { RemotePane } from "../components/remote/RemotePane";
import { RdpPane } from "../components/rdp/RdpPane";
import { VncPane } from "../components/vnc/VncPane";
import { SftpPane } from "../components/sftp/SftpPane";
import { TerminalPane } from "../components/terminal/TerminalPane";
import { moveTabGroupFocus } from "../components/overlays/tabNavigation";
import { useModalFocus } from "../components/overlays/modalFocus";

type SessionRef =
  | {
      kind: "agent";
      sessionId: string;
      label: string;
      headerLabel: string;
      headerMemberLabel: string | null;
      renameLabel: string;
      hasCustomGroupLabel: boolean;
      groupId: string;
      members: AgentSessionSummary[];
    }
  | { kind: "ssh"; sessionId: string; profileId: string; label: string }
  | { kind: "sftp"; sessionId: string; profileId: string; label: string }
  | { kind: "remote"; sessionId: string; profileId: string; label: string }
  | { kind: "rdp"; sessionId: string; profileId: string; label: string }
  | { kind: "vnc"; sessionId: string; profileId: string; label: string };

type AgentSessionRef = Extract<SessionRef, { kind: "agent" }>;

interface SessionRelocationDraft {
  session: AgentSessionRef;
  activeMemberId: string;
  fromDirectory: string;
  toDirectory: string;
}

interface WorkspaceTransferNotice {
  tone: "info" | "warn" | "danger";
  title: string;
  body: string;
}

function workspaceItemSignature(
  item: Pick<
    PortableWorkspaceItem,
    | "groupKey"
    | "definitionId"
    | "label"
    | "launchArguments"
    | "workingDirectory"
  >,
): string {
  return JSON.stringify([
    item.groupKey,
    item.definitionId,
    item.label,
    item.launchArguments,
    normalizeDirectory(item.workingDirectory),
  ]);
}

function workspaceExportFilename(exportedAt = new Date()) {
  return `latticeterm-workspace-${exportedAt
    .toISOString()
    .replace(/[:.]/g, "-")}.json`;
}

async function downloadWorkspaceFile(content: string) {
  const filename = workspaceExportFilename();
  const blob = new Blob([content], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  try {
    return { filename, path: await join(await downloadDir(), filename) };
  } catch {
    return { filename, path: filename };
  }
}

interface ClosedNoticeSource {
  notice: SessionClosedNotice;
  clear: () => void;
}

interface SessionProject {
  id: string;
  label: string;
  workingDirectory: string | null;
  sessions: SessionRef[];
}

function localProjectId(workingDirectory: string): string {
  return `local:${displayPath(workingDirectory).toLocaleLowerCase()}`;
}

/** Comparable form for "is this the same folder" checks across separators. */
function normalizeDirectory(path: string): string {
  return displayPath(path)
    .replace(/[\\/]+$/, "")
    .toLocaleLowerCase();
}

function localProjectLabel(workingDirectory: string): string {
  const plain = displayPath(workingDirectory).replace(/[\\/]+$/, "");
  const segments = plain.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? plain;
}

function projectIdForSession(session: SessionRef): string {
  return session.kind === "agent"
    ? localProjectId(session.members[0]?.workingDirectory ?? session.groupId)
    : "remote-connections";
}

function sidebarProjectNodeId(projectId: string): string {
  return `project:${projectId}`;
}

function sidebarSessionNodeId(session: SessionRef): string {
  return sessionSidebarSessionNodeId(
    session.kind,
    session.sessionId,
    session.kind === "agent" ? session.groupId : session.profileId,
  );
}

export function SessionsView({
  agents,
  ssh,
  sftp,
  remote,
  rdp,
  vnc,
  activeSessionId,
  onSelect,
  theme,
  sessionRestoreComplete,
  restoredWorkspaceSessions,
  unrestoredWorkspaceSessions,
  mobile = false,
}: {
  agents: AgentApi;
  ssh: SshApi;
  sftp: SftpApi;
  remote: RemoteApi;
  rdp: RdpApi;
  vnc: VncApi;
  activeSessionId: string | null;
  onSelect: (sessionId: string | null) => void;
  theme: ThemeId;
  sessionRestoreComplete: boolean;
  restoredWorkspaceSessions: readonly SavedWorkspaceSession[];
  unrestoredWorkspaceSessions: readonly SavedWorkspaceSession[];
  mobile?: boolean;
}) {
  const { t, tag } = useI18n();
  const sessionTabsId = useId();
  const tokenNumber = useMemo(() => new Intl.NumberFormat(tag), [tag]);
  const compactTokenNumber = useMemo(
    () =>
      new Intl.NumberFormat(tag, {
        notation: "compact",
        maximumFractionDigits: 1,
      }),
    [tag],
  );

  // Quick chats launch in the user's home folder and group under a fixed
  // "general chats" project, so asking a CLI something never requires
  // picking a project directory first.
  const [homeDirectory, setHomeDirectory] = useState<string | null>(null);
  useEffect(() => {
    homeDir()
      .then(setHomeDirectory)
      .catch(() => {
        // Browser preview has no Tauri path API; quick chat stays hidden.
      });
  }, []);

  // MobaXterm-style pairing: each SSH tab can reveal a file browser docked
  // beside its terminal, served by an SFTP channel opened on that very SSH
  // session. `pairedSftp` maps the SSH session to its browser's SFTP id, and
  // `filesOpen` tracks which SSH tabs currently show the panel.
  const [pairedSftp, setPairedSftp] = useState<Record<string, string>>({});
  const [filesOpen, setFilesOpen] = useState<Record<string, boolean>>({});

  async function toggleFiles(sshSessionId: string) {
    const opening = !filesOpen[sshSessionId];
    setFilesOpen((prev) => ({ ...prev, [sshSessionId]: opening }));
    if (opening && !pairedSftp[sshSessionId]) {
      const outcome = await sftp.attachToSsh(sshSessionId);
      if (outcome.outcome === "connected") {
        setPairedSftp((prev) => ({
          ...prev,
          [sshSessionId]: outcome.session.sessionId,
        }));
      } else {
        // The channel could not open; leave the panel closed rather than blank.
        setFilesOpen((prev) => ({ ...prev, [sshSessionId]: false }));
      }
    }
  }

  // A fresh SSH tab opens with its file browser visible, so the remote
  // folders are on screen right after connecting; the header toggle still
  // remembers a manual close per tab. The ref guards against re-attaching
  // while the first toggle's state update is still in flight.
  const autoOpenedFilesRef = useRef(new Set<string>());
  useEffect(() => {
    // A phone needs the full width for the prompt. Open SFTP only when asked.
    if (mobile) return;
    for (const session of ssh.sessions) {
      if (
        filesOpen[session.sessionId] === undefined &&
        !autoOpenedFilesRef.current.has(session.sessionId)
      ) {
        autoOpenedFilesRef.current.add(session.sessionId);
        void toggleFiles(session.sessionId);
      }
    }
  }, [ssh.sessions, filesOpen, mobile]);

  // When an SSH tab goes away, tear down the browser channel it owned so the
  // panel and its SFTP session do not linger.
  useEffect(() => {
    const liveSsh = new Set(ssh.sessions.map((session) => session.sessionId));
    const stale = Object.entries(pairedSftp).filter(
      ([sshId]) => !liveSsh.has(sshId),
    );
    if (stale.length === 0) return;
    setPairedSftp((prev) => {
      const next = { ...prev };
      for (const [sshId] of stale) delete next[sshId];
      return next;
    });
    setFilesOpen((prev) => {
      const next = { ...prev };
      for (const [sshId] of stale) delete next[sshId];
      return next;
    });
    for (const [, sftpId] of stale) void sftp.disconnect(sftpId);
  }, [ssh.sessions, pairedSftp, sftp]);

  const pairedSftpIds = new Set(Object.values(pairedSftp));
  // Inline rename of a running agent tab: which session is being edited, and
  // the working text. Committing calls the persisted backend rename.
  const [editingTab, setEditingTab] = useState<string | null>(null);
  const [tabDraft, setTabDraft] = useState("");

  // Which CLI is shown for each multi-CLI tab, remembered so switching tabs
  // returns to the last CLI you used there. `addCliFor` holds the group whose
  // "add a CLI" picker is open.
  const [activeMemberByGroup, setActiveMemberByGroup] = useState<
    Record<string, string>
  >({});
  const [addCliFor, setAddCliFor] = useState<string | null>(null);
  const [selectedAddModel, setSelectedAddModel] = useState<AccountModelSelection | null>(null);
  const addCliDialogRef = useRef<HTMLDivElement>(null);
  const addCliButtonRef = useRef<HTMLButtonElement>(null);
  const [carryContext, setCarryContext] = useState(true);
  const [addCliError, setAddCliError] = useState<{
    title: string;
    body: string;
  } | null>(null);
  const [sidebarLayout, setSidebarLayout] = useState(() =>
    loadSessionSidebarLayout(window.localStorage),
  );
  // A session launched into a collapsed project or folder has no sidebar row
  // yet, so the branch is opened once reconciliation gives it a node.
  const [pendingRevealSessionId, setPendingRevealSessionId] = useState<
    string | null
  >(null);
  const [folderEditor, setFolderEditor] = useState<{
    parentId: string | null;
    folder: SessionSidebarFolder | null;
  } | null>(null);
  const [folderDraft, setFolderDraft] = useState("");
  const [pendingDeleteFolder, setPendingDeleteFolder] =
    useState<SessionSidebarFolder | null>(null);
  const [pendingRemoveSession, setPendingRemoveSession] =
    useState<SessionRef | null>(null);
  const [removingSession, setRemovingSession] = useState(false);
  const [removeSessionError, setRemoveSessionError] = useState<string | null>(
    null,
  );
  const [newProjectDirectory, setNewProjectDirectory] = useState<string | null>(
    null,
  );
  const [selectedProjectModel, setSelectedProjectModel] = useState<AccountModelSelection | null>(
    null,
  );
  const [choosingProject, setChoosingProject] = useState(false);
  const [launchingProjectCli, setLaunchingProjectCli] = useState<string | null>(
    null,
  );
  const [newProjectError, setNewProjectError] = useState<string | null>(null);
  const newProjectDialogRef = useRef<HTMLDivElement>(null);
  const newProjectCancelRef = useRef<HTMLButtonElement>(null);
  const [relocation, setRelocation] = useState<SessionRelocationDraft | null>(
    null,
  );
  const [choosingRelocation, setChoosingRelocation] = useState(false);
  const [relocating, setRelocating] = useState(false);
  const [relocationError, setRelocationError] = useState<string | null>(null);
  const [relocationNotice, setRelocationNotice] = useState<string | null>(null);
  const workspaceImportInputRef = useRef<HTMLInputElement>(null);
  const [workspaceImport, setWorkspaceImport] =
    useState<WorkspaceTransferFile | null>(null);
  const [workspaceImportError, setWorkspaceImportError] = useState<string | null>(
    null,
  );
  const [importingWorkspace, setImportingWorkspace] = useState(false);
  const [pendingClearWorkspace, setPendingClearWorkspace] = useState(false);
  const folderDialogRef = useRef<HTMLDivElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  useModalFocus({
    dialogRef: newProjectDialogRef,
    getInitialFocus: () => newProjectCancelRef.current,
    onEscape: closeNewProjectDialog,
    escapeDisabled: launchingProjectCli !== null,
    active: newProjectDirectory !== null,
  });
  useModalFocus({
    dialogRef: folderDialogRef,
    getInitialFocus: () => folderInputRef.current,
    onEscape: () => setFolderEditor(null),
    active: folderEditor !== null,
  });

  useEffect(() => {
    if (launchingProjectCli) newProjectDialogRef.current?.focus();
  }, [launchingProjectCli]);

  useEffect(() => {
    if (!addCliFor) return;
    const focusFrame = window.requestAnimationFrame(() => {
      const dialog = addCliDialogRef.current;
      const firstControl = dialog?.querySelector<HTMLElement>(
        "input:not(:disabled), button:not(:disabled)",
      );
      (firstControl ?? dialog)?.focus();
    });
    function closeOnPointer(event: PointerEvent) {
      const target = event.target as Node | null;
      if (
        target &&
        (addCliDialogRef.current?.contains(target) ||
          addCliButtonRef.current?.contains(target))
      ) {
        return;
      }
      setAddCliFor(null);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setAddCliFor(null);
      addCliButtonRef.current?.focus();
    }
    document.addEventListener("pointerdown", closeOnPointer, true);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", closeOnPointer, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [addCliFor]);
  const [clearingWorkspace, setClearingWorkspace] = useState(false);
  const [workspaceTransferNotice, setWorkspaceTransferNotice] =
    useState<WorkspaceTransferNotice | null>(null);
  // Mobile hides the sidebar; this opens it as an overlay drawer, the only
  // way to switch sessions there now that the tab strip is gone.
  const [mobileTreeOpen, setMobileTreeOpen] = useState(false);

  const displayAgentCatalog = agentCatalogForDisplay(agents.catalog);
  const installedAgents = displayAgentCatalog.filter(
    (definition) => definition.installed,
  );
  const accountProfiles = useChatAccountProfiles();
  const { statuses: accountStatuses } = useAccountProfileStatus(accountProfiles);
  const modelTargets = accountModelTargets(installedAgents, accountProfiles, accountStatuses, t("accountModel.defaultAccount"));
  const modelLists = useAccountModels(modelTargets, newProjectDirectory !== null || addCliFor !== null);
  // A terminal may also be opened to log in, so signed-out accounts can launch
  // their default CLI here. Chat mode keeps those accounts disabled.
  const modelOptions = accountModelOptions(modelTargets, modelLists, {
    defaultModel: t("terminal.model.pending"), loading: t("chat.model.loading"), signedOut: t("agents.account.signedOut"),
  }, (addCliFor ? selectedAddModel : selectedProjectModel) ?? undefined).map((option) => ({ ...option, disabled: false }));
  const defaultModelSelection = (definitionId?: string): AccountModelSelection | null => {
    const candidates = modelTargets.filter((target) => !definitionId || target.definitionId === definitionId);
    const target = candidates.find((candidate) => !candidate.signedOut) ?? candidates[0];
    return target ? { definitionId: target.definitionId, accountProfileId: target.accountProfileId, model: "" } : null;
  };
  const sessionCliLabel = (session: AgentSessionSummary) => accountSessionLabel(session, modelTargets, t("accountModel.missing"));
  const projectModelAvailable = selectedProjectModel !== null && modelOptions.some((option) => accountModelKey(option) === accountModelKey(selectedProjectModel));

  async function chooseProjectDirectory() {
    setChoosingProject(true);
    setNewProjectError(null);
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t("terminal.projects.choose"),
      });
      if (typeof selected === "string") {
        setNewProjectDirectory(selected);
        setSelectedProjectModel(defaultModelSelection());
      }
    } catch (reason) {
      setNewProjectError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setChoosingProject(false);
    }
  }

  async function chooseRelocationDirectory(session: AgentSessionRef) {
    setChoosingRelocation(true);
    setRelocationError(null);
    setRelocationNotice(null);
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t("terminal.directory.choose"),
      });
      const fromDirectory = session.members[0]?.workingDirectory ?? "";
      if (
        typeof selected !== "string" ||
        normalizeDirectory(selected) === normalizeDirectory(fromDirectory)
      ) {
        return;
      }
      setRelocation({
        session,
        activeMemberId: activeMemberId(session),
        fromDirectory,
        toDirectory: selected,
      });
    } catch (reason) {
      setRelocationError(
        t("terminal.directory.chooseFailed", {
          detail: reason instanceof Error ? reason.message : String(reason),
        }),
      );
    } finally {
      setChoosingRelocation(false);
    }
  }

  async function confirmRelocation() {
    const request = relocation;
    if (!request) return;
    setRelocating(true);
    setRelocationError(null);
    try {
      const outcome = await relocateAgentSessionGroup({
        sessions: request.session.members,
        definitions: agents.catalog,
        activeSessionId: request.activeMemberId,
        workingDirectory: request.toDirectory,
        formatHandoff: (transcript) =>
          t("terminal.handoff.frame", { transcript }),
        api: agents,
      });
      setActiveMemberByGroup((current) => ({
        ...current,
        [request.session.groupId]: outcome.selectedSessionId,
      }));
      onSelect(outcome.selectedSessionId);
      setRelocation(null);
      if (outcome.closeFailures.length > 0) {
        setRelocationNotice(
          t("terminal.directory.partialClose", {
            count: outcome.closeFailures.length,
          }),
        );
      }
    } catch (reason) {
      setRelocationError(
        t("terminal.directory.failed", {
          detail: reason instanceof Error ? reason.message : String(reason),
        }),
      );
    } finally {
      setRelocating(false);
    }
  }

  function classifyWorkspaceImport(transfer: WorkspaceTransferFile) {
    const existingCounts = new Map<string, number>();
    for (const session of agents.sessions) {
      const signature = workspaceItemSignature({
        groupKey: session.groupId || session.sessionId,
        definitionId: session.definitionId,
        label: session.label,
        launchArguments: session.launchArguments,
        workingDirectory: session.workingDirectory,
      });
      existingCounts.set(signature, (existingCounts.get(signature) ?? 0) + 1);
    }

    const pending: PortableWorkspaceItem[] = [];
    let unavailableCount = 0;
    let existingCount = 0;
    for (const item of transfer.items) {
      const definition = agents.catalog.find(
        (candidate) => candidate.id === item.definitionId,
      );
      if (item.definitionId === "custom" || !definition?.installed) {
        unavailableCount += 1;
        continue;
      }
      const signature = workspaceItemSignature(item);
      const count = existingCounts.get(signature) ?? 0;
      if (count > 0) {
        existingCount += 1;
        existingCounts.set(signature, count - 1);
        continue;
      }
      pending.push(item);
    }
    return { pending, unavailableCount, existingCount };
  }

  async function exportWorkspaceItems() {
    setWorkspaceTransferNotice(null);
    if (agents.sessions.length === 0 && reconciledSidebarLayout.folders.length === 0) {
      setWorkspaceTransferNotice({
        tone: "warn",
        title: t("terminal.projects.export"),
        body: t("terminal.projects.exportEmpty"),
      });
      return;
    }
    const exported = await downloadWorkspaceFile(
      serializeWorkspaceTransfer(agents.sessions, reconciledSidebarLayout),
    );
    setWorkspaceTransferNotice({
      tone: "info",
      title: t("terminal.projects.exportedTitle"),
      body: `${t("terminal.projects.exported", {
        projects: new Set(
          agents.sessions.map((session) =>
            normalizeDirectory(session.workingDirectory),
          ),
        ).size,
        sessions: agents.sessions.length,
        folders: reconciledSidebarLayout.folders.length,
      })} ${t("terminal.projects.exportedLocation", {
        ...exported,
        path: displayPath(exported.path),
      })}`,
    });
  }

  async function readWorkspaceImport(file: File) {
    setWorkspaceTransferNotice(null);
    setWorkspaceImportError(null);
    try {
      if (file.size > MAX_WORKSPACE_TRANSFER_BYTES) {
        throw new Error(t("terminal.projects.importInvalid"));
      }
      const transfer = parseWorkspaceTransfer(await file.text());
      if (!transfer) throw new Error(t("terminal.projects.importInvalid"));
      setWorkspaceImport(transfer);
    } catch (reason) {
      setWorkspaceTransferNotice({
        tone: "danger",
        title: t("terminal.projects.importFailedTitle"),
        body:
          reason instanceof Error
            ? reason.message
            : t("terminal.projects.importReadFailed", {
                detail: String(reason),
              }),
      });
    }
  }

  async function confirmWorkspaceImport() {
    const transfer = workspaceImport;
    if (!transfer) return;
    const classification = classifyWorkspaceImport(transfer);
    setImportingWorkspace(true);
    setWorkspaceImportError(null);
    const renamedGroups = new Set<string>();
    const failures: string[] = [];
    const launched: AgentSessionSummary[] = [];
    try {
      for (const item of classification.pending) {
        try {
          const session = await agents.launch({
            definitionId: item.definitionId,
            label: item.label,
            executable: item.executable,
            arguments: item.launchArguments,
            resumeSessionId: null,
            groupId: item.groupKey,
            seedInput: null,
            restoreExistingSession: false,
            workingDirectory: item.workingDirectory,
            cols: 120,
            rows: 32,
          });
          launched.push(session);
          if (!renamedGroups.has(item.groupKey)) {
            renamedGroups.add(item.groupKey);
            try {
              await agents.rename(session.sessionId, item.groupLabel);
            } catch {
              // The imported CLI is usable even if its display name stays local.
            }
          }
        } catch (reason) {
          failures.push(
            `${item.groupLabel}: ${
              reason instanceof Error ? reason.message : String(reason)
            }`,
          );
        }
      }
      updateSidebarLayout((layout) =>
        mergeSessionSidebarLayouts(layout, transfer.sidebar),
      );
      setWorkspaceImport(null);
      const skipped =
        classification.unavailableCount + classification.existingCount;
      setWorkspaceTransferNotice({
        tone: failures.length > 0 ? "warn" : "info",
        title: t("terminal.projects.importedTitle"),
        body: `${t("terminal.projects.imported", {
          imported: launched.length,
          skipped,
          failed: failures.length,
        })}${failures.length > 0 ? ` ${failures.slice(0, 3).join("；")}` : ""}`,
      });
      if (launched[0]) {
        setPendingRevealSessionId(launched[0].sessionId);
        onSelect(launched[0].sessionId);
      }
    } catch (reason) {
      setWorkspaceImportError(
        reason instanceof Error ? reason.message : String(reason),
      );
    } finally {
      setImportingWorkspace(false);
    }
  }

  async function clearWorkspaceItems() {
    setClearingWorkspace(true);
    setWorkspaceTransferNotice(null);
    try {
      await disconnectAgentSessionMembers(
        agents.sessions.map((session) => session.sessionId),
        agents.disconnect,
      );
      if (
        agents.sessions.some((session) => session.sessionId === activeSessionId)
      ) {
        onSelect(null);
      }
      setSidebarLayout({
        ...emptySessionSidebarLayout,
        folders: [],
        placements: {},
        collapsedFolderIds: [],
      });
      setPendingClearWorkspace(false);
      setWorkspaceTransferNotice({
        tone: "info",
        title: t("terminal.projects.clearedTitle"),
        body: t("terminal.projects.cleared"),
      });
    } catch (reason) {
      setPendingClearWorkspace(false);
      setWorkspaceTransferNotice({
        tone: "danger",
        title: t("terminal.projects.clearFailedTitle"),
        body: t("terminal.projects.clearFailed", {
          detail: reason instanceof Error ? reason.message : String(reason),
        }),
      });
    } finally {
      setClearingWorkspace(false);
    }
  }

  function closeNewProjectDialog() {
    if (launchingProjectCli) return;
    setNewProjectDirectory(null);
    setSelectedProjectModel(null);
    setNewProjectError(null);
  }

  function beginRename(sessionId: string, label: string) {
    setEditingTab(sessionId);
    setTabDraft(label);
  }

  async function commitRename(sessionId: string) {
    const label = tabDraft.trim();
    setEditingTab(null);
    if (label.length > 0) {
      try {
        await agents.rename(sessionId, label);
      } catch {
        // A rejected label just leaves the previous name in place.
      }
    }
  }

  function selectMember(groupId: string, sessionId: string) {
    setActiveMemberByGroup((prev) => ({ ...prev, [groupId]: sessionId }));
    onSelect(sessionId);
  }

  async function addCli(
    group: { groupId: string; members: AgentSessionSummary[] },
    selection: AccountModelSelection,
    carryContext: boolean,
  ) {
    setAddCliFor(null);
    setAddCliError(null);
    const workingDirectory = group.members[0]?.workingDirectory ?? "";
    let seedInput: string | null = null;
    if (carryContext) {
      // Read the source transcript and hand it to the new CLI once through
      // a LatticeTerm-owned brief, without rewriting its memory directory.
      const sourceId = activeMemberId(group);
      const source = group.members.find(
        (member) => member.sessionId === sourceId,
      );
      try {
        const transcript = await agents.exportTranscript(sourceId);
        if (!transcript) {
          setAddCliError({
            title: t("terminal.handoff.exportFailedTitle"),
            body: t("terminal.handoff.exportFailed"),
          });
          return;
        }
        try {
          const path = await agents.writeHandoffFile(source?.label ?? "", transcript);
          seedInput = t("terminal.handoff.filePointer", {
            path,
            source: source?.label ?? t("terminal.handoff.anotherAssistant"),
          });
        } catch {
          seedInput = t("terminal.handoff.frame", { transcript });
        }
      } catch {
        setAddCliError({
          title: t("terminal.handoff.exportFailedTitle"),
          body: t("terminal.handoff.exportFailed"),
        });
        return;
      }
    }
    try {
      const session = await agents.launch({
        definitionId: selection.definitionId,
        label: "",
        executable: "",
        ...accountModelLaunchSettings(selection, accountProfiles),
        resumeSessionId: null,
        groupId: group.groupId,
        seedInput,
        workingDirectory,
        cols: 80,
        rows: 24,
      });
      setPendingRevealSessionId(session.sessionId);
      selectMember(group.groupId, session.sessionId);
    } catch {
      setAddCliError({
        title: t("terminal.addCli.failed"),
        body: t("terminal.addCli.failedBody"),
      });
    }
  }

  // Collapse agent CLIs that share a groupId into one tab, first-seen order.
  const agentGroups: { groupId: string; members: AgentSessionSummary[] }[] = [];
  const groupIndex = new Map<string, number>();
  for (const session of agents.sessions) {
    const gid = session.groupId || session.sessionId;
    const existing = groupIndex.get(gid);
    if (existing === undefined) {
      groupIndex.set(gid, agentGroups.length);
      agentGroups.push({ groupId: gid, members: [session] });
    } else {
      agentGroups[existing].members.push(session);
    }
  }

  const activeMemberId = (group: {
    groupId: string;
    members: AgentSessionSummary[];
  }): string => {
    if (
      activeSessionId &&
      group.members.some((member) => member.sessionId === activeSessionId)
    ) {
      return activeSessionId;
    }
    const remembered = activeMemberByGroup[group.groupId];
    if (remembered && group.members.some((m) => m.sessionId === remembered)) {
      return remembered;
    }
    return group.members[0].sessionId;
  };

  const sessions: SessionRef[] = [
    ...agentGroups.map((group) => {
      const memberId = activeMemberId(group);
      const presentation = presentAgentSessionGroup(
        group.members,
        agents.catalog,
        memberId,
      );
      return {
        kind: "agent" as const,
        sessionId: memberId,
        label: presentation.groupLabel,
        headerLabel: presentation.headerLabel,
        headerMemberLabel: presentation.headerMemberLabel,
        renameLabel: presentation.renameLabel,
        hasCustomGroupLabel: presentation.hasCustomGroupLabel,
        groupId: group.groupId,
        members: group.members,
      };
    }),
    ...ssh.sessions.map((session) => ({
      kind: "ssh" as const,
      sessionId: session.sessionId,
      profileId: session.profileId,
      label: `${session.username}@${session.host}`,
    })),
    ...sftp.sessions
      .filter((session) => !pairedSftpIds.has(session.sessionId))
      .map((session) => ({
        kind: "sftp" as const,
        sessionId: session.sessionId,
        profileId: session.profileId,
        label: `${session.username}@${session.host}`,
      })),
    ...remote.sessions.map((session) => ({
      kind: "remote" as const,
      sessionId: session.sessionId,
      profileId: session.profileId,
      label: session.agentName,
    })),
    ...rdp.sessions.map((session) => ({
      kind: "rdp" as const,
      sessionId: session.sessionId,
      profileId: session.profileId,
      label: `${session.username}@${session.host}`,
    })),
    ...vnc.sessions.map((session) => ({
      kind: "vnc" as const,
      sessionId: session.sessionId,
      profileId: session.profileId,
      label: `${session.host}:${session.port}`,
    })),
  ];

  const closedNotices: ClosedNoticeSource[] = [];
  if (agents.lastClosed) {
    closedNotices.push({
      notice: agents.lastClosed,
      clear: agents.clearLastClosed,
    });
  }
  if (ssh.lastClosed) {
    closedNotices.push({ notice: ssh.lastClosed, clear: ssh.clearLastClosed });
  }
  if (remote.lastClosed) {
    closedNotices.push({
      notice: remote.lastClosed,
      clear: remote.clearLastClosed,
    });
  }
  if (rdp.lastClosed) {
    closedNotices.push({ notice: rdp.lastClosed, clear: rdp.clearLastClosed });
  }
  if (vnc.lastClosed) {
    closedNotices.push({ notice: vnc.lastClosed, clear: vnc.clearLastClosed });
  }
  const latestClosed = closedNotices.sort(
    (left, right) => right.notice.at - left.notice.at,
  )[0];
  const closedCallout = latestClosed ? (
    <div className="session-notice">
      <Callout
        tone="warn"
        title={t(
          isSuccessfulProcessExit(latestClosed.notice.reason)
            ? "terminal.sessionEnded.title"
            : "terminal.sessionClosed.title",
        )}
        actions={
          <button
            type="button"
            className="button button--ghost button--sm"
            onClick={latestClosed.clear}
          >
            {t("common.close")}
          </button>
        }
      >
        {t("terminal.sessionClosed.body", {
          name: latestClosed.notice.label,
          reason: latestClosed.notice.reason,
        })}
      </Callout>
    </div>
  ) : null;

  async function launchNewProject() {
    if (!newProjectDirectory || !selectedProjectModel || !projectModelAvailable || launchingProjectCli) return;
    const definition = installedAgents.find(
      (candidate) => candidate.id === selectedProjectModel.definitionId,
    );
    if (!definition) return;
    setLaunchingProjectCli(definition.id);
    setNewProjectError(null);
    try {
      const launched = await agents.launch({
        definitionId: definition.id,
        label: "",
        executable: "",
        ...accountModelLaunchSettings(selectedProjectModel, accountProfiles),
        resumeSessionId: null,
        groupId: null,
        seedInput: null,
        workingDirectory: newProjectDirectory,
        cols: 120,
        rows: 32,
      });
      setNewProjectDirectory(null);
      setSelectedProjectModel(null);
      setPendingRevealSessionId(launched.sessionId);
      onSelect(launched.sessionId);
    } catch (reason) {
      setNewProjectError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLaunchingProjectCli(null);
    }
  }

  const newProjectDialog = newProjectDirectory ? (
    <div
      className="scrim scrim--center"
      role="presentation"
      onMouseDown={closeNewProjectDialog}
    >
      <div
        ref={newProjectDialogRef}
        className="dialog dialog--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog__head">
          <span className="dialog__icon dialog__icon--inline" aria-hidden="true">
            <FolderIcon size={18} />
          </span>
          <h2 className="dialog__title" id="new-project-title">
            {t("terminal.projects.launchTitle")}
          </h2>
        </header>
        <div className="dialog__stack">
          <div>
            <span className="field__label">{t("terminal.projects.directory")}</span>
            <p className="dialog__body mono project-launcher__path">
              {displayPath(newProjectDirectory)}
            </p>
          </div>
          <AccountModelField
            options={modelOptions}
            value={selectedProjectModel}
            disabled={launchingProjectCli !== null}
            onChange={setSelectedProjectModel}
          />
          {installedAgents.length === 0 && <p className="dialog__body">{t("terminal.addCli.none")}</p>}
          {newProjectError && (
            <Callout tone="danger" title={t("terminal.projects.launchFailed")}>
              <span className="mono">{newProjectError}</span>
            </Callout>
          )}
          <div className="dialog__actions">
            <button
              ref={newProjectCancelRef}
              type="button"
              className="button button--ghost"
              disabled={launchingProjectCli !== null}
              onClick={closeNewProjectDialog}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="button button--primary"
              disabled={launchingProjectCli !== null || !projectModelAvailable}
              onClick={() => void launchNewProject()}
            >
              {launchingProjectCli
                ? t("terminal.projects.launching")
                : t("terminal.projects.launch")}
            </button>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  const relocationSummary = relocation
    ? summarizeAgentRelocation(relocation.session.members, agents.catalog)
    : null;
  const relocationDialog = relocation && relocationSummary ? (
    <AgentSessionRelocationDialog
      name={relocation.session.label}
      sessionCount={relocation.session.members.length}
      fromDirectory={relocation.fromDirectory}
      toDirectory={relocation.toDirectory}
      summary={relocationSummary}
      busy={relocating}
      error={relocationError}
      onConfirm={() => void confirmRelocation()}
      onCancel={() => setRelocation(null)}
    />
  ) : null;

  const active =
    sessions.find((session) => session.sessionId === activeSessionId) ??
    sessions[0] ??
    null;
  // Live host readings for the active SSH tab, polled only while its files
  // sidebar is on screen.
  const activeSshSessionId =
    active?.kind === "ssh" && filesOpen[active.sessionId]
      ? active.sessionId
      : null;
  const sshHostMetrics = useSessionHostMetrics(activeSshSessionId);
  const projectMap = new Map<string, SessionProject>();
  for (const workingDirectory of savedAgentWorkingDirectories(
    unrestoredWorkspaceSessions,
  )) {
    const id = localProjectId(workingDirectory);
    const isGeneralChat =
      !!homeDirectory &&
      normalizeDirectory(workingDirectory) === normalizeDirectory(homeDirectory);
    projectMap.set(id, {
      id,
      label: isGeneralChat
        ? t("terminal.projects.generalChat")
        : localProjectLabel(workingDirectory),
      workingDirectory,
      sessions: [],
    });
  }
  for (const session of sessions) {
    const id = projectIdForSession(session);
    const existing = projectMap.get(id);
    if (existing) {
      existing.sessions.push(session);
      continue;
    }
    const workingDirectory =
      session.kind === "agent"
        ? session.members[0]?.workingDirectory ?? null
        : null;
    const isGeneralChat =
      !!workingDirectory &&
      !!homeDirectory &&
      normalizeDirectory(workingDirectory) === normalizeDirectory(homeDirectory);
    projectMap.set(id, {
      id,
      label: workingDirectory
        ? isGeneralChat
          ? t("terminal.projects.generalChat")
          : localProjectLabel(workingDirectory)
        : t("terminal.projects.remote"),
      workingDirectory,
      sessions: [session],
    });
  }
  const projects = [...projectMap.values()];
  const activeProjectId = active ? projectIdForSession(active) : null;
  const activeProject =
    projects.find((project) => project.id === activeProjectId) ?? projects[0] ?? null;
  const sidebarProjects: SessionSidebarProjectItem[] = projects.map((project) => ({
    nodeId: sidebarProjectNodeId(project.id),
    projectId: project.id,
    label: project.label,
    workingDirectory: project.workingDirectory,
    sessions: project.sessions.flatMap<SessionSidebarSessionItem>((session) => {
      if (session.kind !== "agent") {
        return [
          {
            nodeId: sidebarSessionNodeId(session),
            sessionId: session.sessionId,
            label: session.label,
            kind: session.kind,
            searchText: session.label,
            status: "connected" as const,
          },
        ];
      }
      return session.members.map((member, memberIndex) => ({
        nodeId: agentSessionSidebarMemberNodeId(
          session.groupId,
          session.members,
          memberIndex,
        ),
        sessionId: member.sessionId,
        label: session.hasCustomGroupLabel
          ? `${session.label} · ${sessionCliLabel(member)}`
          : sessionCliLabel(member),
        detail: member.model ?? t("terminal.model.pending"),
        kind: "agent" as const,
        searchText: [
          session.label,
          sessionCliLabel(member),
          member.definitionId,
          member.model ?? "",
        ].join(" "),
        status: agentGroupSidebarStatus([member]),
      }));
    }),
  }));
  const restoredSidebarNodes = useMemo(() => {
    const nodes = new Map<string, LiveSessionSidebarNode>();
    const restoredAgentGroups = new Map<
      string,
      Extract<SavedWorkspaceSession, { kind: "agent" }>[]
    >();
    for (const session of restoredWorkspaceSessions) {
      if (session.kind === "agent") {
        const projectNodeId = sidebarProjectNodeId(
          localProjectId(session.workingDirectory),
        );
        nodes.set(projectNodeId, {
          id: projectNodeId,
          defaultParentId: null,
        });
        const group = restoredAgentGroups.get(session.groupKey) ?? [];
        group.push(session);
        restoredAgentGroups.set(session.groupKey, group);
        continue;
      }

      const projectNodeId = sidebarProjectNodeId("remote-connections");
      nodes.set(projectNodeId, { id: projectNodeId, defaultParentId: null });
      const sessionNodeId = sessionSidebarSessionNodeId(
        "ssh",
        session.profileId,
        session.profileId,
      );
      nodes.set(sessionNodeId, {
        id: sessionNodeId,
        defaultParentId: projectNodeId,
      });
    }
    for (const [groupKey, members] of restoredAgentGroups) {
      const sidebarMembers = members.map((member) => ({
        ...member,
        // The stable portion of the node id is derived from the launch
        // identity below. This temporary value only fulfils the runtime-id
        // parameter until the restored CLI receives its new process id.
        sessionId: member.groupKey,
      }));
      members.forEach((member, memberIndex) => {
        const nodeId = agentSessionSidebarMemberNodeId(
          groupKey,
          sidebarMembers,
          memberIndex,
        );
        nodes.set(nodeId, {
          id: nodeId,
          defaultParentId: sidebarProjectNodeId(
            localProjectId(member.workingDirectory),
          ),
        });
      });
    }
    return [...nodes.values()];
  }, [restoredWorkspaceSessions]);
  const liveSidebarNodes: LiveSessionSidebarNode[] = sidebarProjects.flatMap(
    (project) => [
      { id: project.nodeId, defaultParentId: null },
      ...project.sessions.map((session) => ({
        id: session.nodeId,
        defaultParentId: project.nodeId,
      })),
    ],
  );
  const reconciledSidebarLayout = reconcileSessionSidebarLayout(
    sidebarLayout,
    liveSidebarNodes,
    restoredSidebarNodes,
  );
  const liveSidebarKey = [...liveSidebarNodes, ...restoredSidebarNodes]
    .map((node) => `${node.id}>${node.defaultParentId ?? "root"}`)
    .join("|");
  const liveSidebarNodesRef = useRef(liveSidebarNodes);
  liveSidebarNodesRef.current = liveSidebarNodes;
  // Layout edits queued in the same event must each see the previous result.
  // Handing `setSidebarLayout` an already computed layout let a second call
  // (a drop that also has to expand its destination) discard the first.
  function updateSidebarLayout(
    update: (layout: SessionSidebarLayout) => SessionSidebarLayout,
  ) {
    setSidebarLayout((current) => {
      const reconciled = reconcileSessionSidebarLayout(
        current,
        liveSidebarNodesRef.current,
        restoredSidebarNodes,
      );
      const next = update(reconciled);
      // A reveal that had nothing collapsed must not churn state or rewrite
      // the saved layout.
      return next === reconciled &&
        JSON.stringify(next) === JSON.stringify(current)
        ? current
        : next;
    });
  }
  useEffect(() => {
    if (!sessionRestoreComplete) return;
    setSidebarLayout((current) => {
      const next = reconcileSessionSidebarLayout(
        current,
        liveSidebarNodes,
        restoredSidebarNodes,
      );
      return JSON.stringify(next) === JSON.stringify(current) ? current : next;
    });
  }, [liveSidebarKey, restoredSidebarNodes, sessionRestoreComplete]);
  useEffect(() => {
    if (!pendingRevealSessionId) return;
    const revealed = sidebarProjects
      .flatMap((project) => project.sessions)
      .find((session) => session.sessionId === pendingRevealSessionId);
    if (!revealed) return;
    updateSidebarLayout((layout) =>
      expandSessionSidebarAncestors(layout, revealed.nodeId),
    );
    setPendingRevealSessionId(null);
  }, [liveSidebarKey, pendingRevealSessionId]);
  useEffect(() => {
    if (!sessionRestoreComplete) return;
    try {
      saveSessionSidebarLayout(window.localStorage, sidebarLayout);
    } catch {
      // Sidebar organization is a convenience and must not interrupt sessions.
    }
  }, [sessionRestoreComplete, sidebarLayout]);

  function openFolderEditor(
    parentId: string | null,
    folder: SessionSidebarFolder | null = null,
  ) {
    setFolderDraft(folder?.name ?? "");
    setFolderEditor({ parentId, folder });
  }

  function saveFolder() {
    if (!folderEditor || !folderDraft.trim()) return;
    if (folderEditor.folder) {
      const folderId = folderEditor.folder.id;
      updateSidebarLayout((layout) =>
        renameSessionSidebarFolder(layout, folderId, folderDraft),
      );
    } else {
      const suffix =
        typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      updateSidebarLayout((layout) =>
        createSessionSidebarFolder(
          layout,
          { id: `folder:${suffix}`, name: folderDraft },
          folderEditor.parentId,
        ),
      );
    }
    setFolderEditor(null);
  }

  const folderDialog = folderEditor ? (
    <div
      className="scrim scrim--center"
      role="presentation"
      onMouseDown={() => setFolderEditor(null)}
    >
      <div
        ref={folderDialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-folder-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog__head">
          <span className="dialog__icon dialog__icon--inline" aria-hidden="true">
            <FolderIcon size={17} />
          </span>
          <h2 className="dialog__title" id="session-folder-title">
            {t(
              folderEditor.folder
                ? "terminal.projects.folderRename"
                : "terminal.projects.folderTitle",
            )}
          </h2>
        </header>
        <form
          className="dialog__stack"
          onSubmit={(event) => {
            event.preventDefault();
            saveFolder();
          }}
        >
          <label className="field">
            <span className="field__label">{t("terminal.projects.folderName")}</span>
            <input
              ref={folderInputRef}
              className="input"
              maxLength={80}
              value={folderDraft}
              onChange={(event) => setFolderDraft(event.currentTarget.value)}
              placeholder={t("terminal.projects.folderNamePlaceholder")}
            />
          </label>
          <div className="dialog__actions">
            <button
              type="button"
              className="button button--ghost"
              onClick={() => setFolderEditor(null)}
            >
              {t("common.cancel")}
            </button>
            <button
              type="submit"
              className="button button--primary"
              disabled={!folderDraft.trim()}
            >
              {t(
                folderEditor.folder
                  ? "terminal.projects.folderSave"
                  : "terminal.projects.folderCreate",
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  ) : null;

  const workspaceImportClassification = workspaceImport
    ? classifyWorkspaceImport(workspaceImport)
    : null;
  const workspaceImportDialog =
    workspaceImport && workspaceImportClassification ? (
      <WorkspaceImportDialog
        transfer={workspaceImport}
        unavailableCount={workspaceImportClassification.unavailableCount}
        existingCount={workspaceImportClassification.existingCount}
        busy={importingWorkspace}
        error={workspaceImportError}
        onConfirm={() => void confirmWorkspaceImport()}
        onCancel={() => {
          if (importingWorkspace) return;
          setWorkspaceImport(null);
          setWorkspaceImportError(null);
        }}
      />
    ) : null;
  const workspaceFilePicker = (
    <input
      ref={workspaceImportInputRef}
      type="file"
      accept=".json,application/json"
      className="visually-hidden"
      tabIndex={-1}
      onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (file) void readWorkspaceImport(file);
      }}
    />
  );
  const workspaceTransferCallout = workspaceTransferNotice ? (
    <div className="session-notice">
      <Callout
        tone={workspaceTransferNotice.tone}
        title={workspaceTransferNotice.title}
        actions={
          <button
            type="button"
            className="button button--ghost button--sm"
            onClick={() => setWorkspaceTransferNotice(null)}
          >
            {t("common.close")}
          </button>
        }
      >
        {workspaceTransferNotice.body}
      </Callout>
    </div>
  ) : null;
  const addCliErrorCallout = addCliError ? (
    <div className="session-notice">
      <Callout
        tone="danger"
        title={addCliError.title}
        actions={
          <button
            type="button"
            className="button button--ghost button--sm"
            onClick={() => setAddCliError(null)}
          >
            {t("common.close")}
          </button>
        }
      >
        {addCliError.body}
      </Callout>
    </div>
  ) : null;
  const clearWorkspaceDialog = pendingClearWorkspace ? (
    <ConfirmDialog
      title={t("terminal.projects.clearTitle")}
      body={t("terminal.projects.clearBody", {
        sessions: agents.sessions.length,
      })}
      confirmLabel={t(
        clearingWorkspace
          ? "terminal.projects.clearing"
          : "terminal.projects.clearAction",
      )}
      cancelLabel={t("common.cancel")}
      confirmDisabled={clearingWorkspace}
      busy={clearingWorkspace}
      onCancel={() => {
        if (!clearingWorkspace) setPendingClearWorkspace(false);
      }}
      onConfirm={() => {
        if (!clearingWorkspace) void clearWorkspaceItems();
      }}
    />
  ) : null;

  function openSavedProject(workingDirectory: string) {
    setNewProjectError(null);
    setNewProjectDirectory(workingDirectory);
    setSelectedProjectModel(defaultModelSelection());
  }

  const projectSidebar = (
    <SessionProjectSidebar
      projects={sidebarProjects}
      layout={reconciledSidebarLayout}
      activeSessionId={active?.sessionId ?? null}
      choosingProject={choosingProject}
      chooseError={Boolean(newProjectError && !newProjectDialog)}
      installedAgents={installedAgents}
      mobileOpen={mobileTreeOpen}
      onMobileClose={() => setMobileTreeOpen(false)}
      onChooseProject={() => void chooseProjectDirectory()}
      onLaunchProject={openSavedProject}
      onSelect={(sessionId) => {
        setMobileTreeOpen(false);
        const group = agentGroups.find((candidate) =>
          candidate.members.some((member) => member.sessionId === sessionId),
        );
        if (group) selectMember(group.groupId, sessionId);
        else onSelect(sessionId);
      }}
      onRemove={(sidebarSession) => {
        const session = sessions.find((candidate) =>
          candidate.kind === "agent"
            ? candidate.members.some(
                (member) => member.sessionId === sidebarSession.sessionId,
              )
            : sidebarSessionNodeId(candidate) === sidebarSession.nodeId,
        );
        if (!session) return;
        setRemoveSessionError(null);
        setPendingRemoveSession(
          session.kind === "agent"
            ? {
                ...session,
                sessionId: sidebarSession.sessionId,
                label: sidebarSession.label,
              }
            : session,
        );
      }}
      onQuickLaunch={(definition) => {
        setMobileTreeOpen(false);
        void launchQuickChat(definition);
      }}
      onExportWorkspace={() => {
        setMobileTreeOpen(false);
        void exportWorkspaceItems();
      }}
      onImportWorkspace={() => {
        setMobileTreeOpen(false);
        workspaceImportInputRef.current?.click();
      }}
      onClearWorkspace={() => {
        setMobileTreeOpen(false);
        setPendingClearWorkspace(true);
      }}
      onCreateFolder={(parentId) => openFolderEditor(parentId)}
      onRenameFolder={(folder) =>
        openFolderEditor(
          reconciledSidebarLayout.placements[folder.id]?.parentId ?? null,
          folder,
        )
      }
      onDeleteFolder={setPendingDeleteFolder}
      onToggleFolder={(folderId) =>
        updateSidebarLayout((layout) =>
          toggleSessionSidebarFolder(layout, folderId),
        )
      }
      onRevealNode={(nodeId) =>
        updateSidebarLayout((layout) =>
          expandSessionSidebarAncestors(layout, nodeId),
        )
      }
      onMove={(nodeId, parentId, beforeNodeId) =>
        updateSidebarLayout((layout) =>
          moveSessionSidebarNode(layout, nodeId, parentId, beforeNodeId),
        )
      }
    />
  );

  if (!active || !activeProject) {
    return (
      <div className="terminal-workspace">
        {workspaceFilePicker}
        {closedCallout}
        {workspaceTransferCallout}
        {addCliErrorCallout}
        {newProjectError && !newProjectDialog && (
          <div className="session-notice">
            <Callout tone="danger" title={t("terminal.projects.chooseFailed")}>
              <span className="mono">{newProjectError}</span>
            </Callout>
          </div>
        )}
        <div className="terminal-workspace__body">
          {mobileTreeOpen && (
            <div
              className="session-projects-scrim"
              role="presentation"
              onClick={() => setMobileTreeOpen(false)}
            />
          )}
          {sidebarProjects.length > 0 && projectSidebar}
          <section className="terminal-project-workspace">
            <EmptyState
              icon={<TerminalIcon size={26} />}
              title={t("terminal.empty.title")}
              description={t(
                sidebarProjects.length > 0
                  ? "terminal.empty.savedBody"
                  : "terminal.empty.body",
              )}
              actions={
                <>
                  {sidebarProjects.length > 0 && (
                    <button
                      type="button"
                      className="button button--ghost"
                      onClick={() => setMobileTreeOpen(true)}
                    >
                      <FolderIcon size={14} />
                      {t("terminal.projects")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="button button--primary"
                    disabled={choosingProject}
                    onClick={() => void chooseProjectDirectory()}
                  >
                    <FolderIcon size={14} />
                    {t(
                      choosingProject
                        ? "terminal.projects.choosing"
                        : "terminal.projects.add",
                    )}
                  </button>
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={() => workspaceImportInputRef.current?.click()}
                  >
                    <ImportIcon size={14} />
                    {t("terminal.projects.import")}
                  </button>
                  {homeDirectory && installedAgents.length > 0 && (
                  <div className="terminal-empty-quick">
                    <small>{t("terminal.empty.quickChat")}</small>
                    <div className="terminal-empty-quick__list">
                      {installedAgents.map((definition) => (
                          <button
                            type="button"
                            className="button button--ghost button--sm"
                            key={definition.id}
                            onClick={() => void launchQuickChat(definition)}
                          >
                            <AgentIcon size={12} />
                            {definition.label}
                          </button>
                        ))}
                    </div>
                  </div>
                  )}
                </>
              }
            />
          </section>
        </div>
        {newProjectDialog}
        {folderDialog}
        {workspaceImportDialog}
        {clearWorkspaceDialog}
      </div>
    );
  }

  async function launchQuickChat(definition: AgentDefinition) {
    try {
      const home = homeDirectory ?? (await homeDir());
      setNewProjectError(null);
      setSelectedProjectModel(defaultModelSelection(definition.id));
      setNewProjectDirectory(home);
    } catch {
      // A failed quick chat leaves the workspace untouched.
    }
  }

  async function closeAgentMember(
    members: AgentSessionSummary[],
    sessionId: string,
  ) {
    await agents.disconnect(sessionId);
    // Closing the visible CLI hands focus to a sibling if the tab still has
    // one, so the whole tab only disappears once its last CLI is gone.
    if (sessionId === active.sessionId) {
      const sibling = members.find((member) => member.sessionId !== sessionId);
      onSelect(sibling?.sessionId ?? null);
    }
  }

  async function close(session: SessionRef) {
    if (session.kind === "agent") {
      await closeAgentMember(session.members, session.sessionId);
      return;
    }
    if (session.kind === "ssh") await ssh.disconnect(session.sessionId);
    else if (session.kind === "sftp") await sftp.disconnect(session.sessionId);
    else if (session.kind === "remote") await remote.disconnect(session.sessionId);
    else if (session.kind === "rdp") await rdp.disconnect(session.sessionId);
    else await vnc.disconnect(session.sessionId);
    if (session.sessionId === active.sessionId) onSelect(null);
  }

  async function removeSession(session: SessionRef) {
    await close(session);
  }

  return (
    <div className="terminal-workspace">
      {workspaceFilePicker}
      {closedCallout}
      {workspaceTransferCallout}
      {addCliErrorCallout}
      {relocationNotice && (
        <div className="session-notice">
          <Callout
            tone="warn"
            title={t("terminal.directory.partialCloseTitle")}
            actions={
              <button
                type="button"
                className="button button--ghost button--sm"
                onClick={() => setRelocationNotice(null)}
              >
                {t("common.close")}
              </button>
            }
          >
            {relocationNotice}
          </Callout>
        </div>
      )}
      {relocationError && !relocation && (
        <div className="session-notice">
          <Callout
            tone="danger"
            title={t("terminal.directory.failedTitle")}
            actions={
              <button
                type="button"
                className="button button--ghost button--sm"
                onClick={() => setRelocationError(null)}
              >
                {t("common.close")}
              </button>
            }
          >
            <span className="mono">{relocationError}</span>
          </Callout>
        </div>
      )}
      <div className="terminal-workspace__body">
        {mobileTreeOpen && (
          <div
            className="session-projects-scrim"
            role="presentation"
            onClick={() => setMobileTreeOpen(false)}
          />
        )}
        {projectSidebar}

        <section className="terminal-project-workspace">
          {(() => {
            const ActiveGlyph =
              active.kind === "agent"
                ? AgentIcon
                : active.kind === "ssh"
                  ? TerminalIcon
                  : active.kind === "sftp"
                    ? TransferIcon
                    : ScreenShareIcon;
            return (
              <header className="session-header">
                <button
                  type="button"
                  className="icon-button icon-button--sm session-header__tree-toggle"
                  onClick={() => setMobileTreeOpen(true)}
                  aria-label={t("terminal.projects")}
                  aria-haspopup="dialog"
                  aria-expanded={mobileTreeOpen}
                  aria-controls="session-project-sidebar"
                  title={t("terminal.projects")}
                >
                  <FolderIcon size={14} />
                </button>
                <div className="session-header__crumbs">
                  <span
                    className="session-header__project truncate"
                    title={
                      activeProject.workingDirectory
                        ? displayPath(activeProject.workingDirectory)
                        : activeProject.label
                    }
                  >
                    {activeProject.label}
                  </span>
                  <span className="session-header__sep" aria-hidden="true">
                    ›
                  </span>
                  {editingTab === active.sessionId ? (
                    <span className="session-header__label">
                      <ActiveGlyph size={13} />
                      <input
                        className="session-header__rename"
                        value={tabDraft}
                        autoFocus
                        maxLength={80}
                        onChange={(event) => setTabDraft(event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void commitRename(active.sessionId);
                          else if (event.key === "Escape") setEditingTab(null);
                        }}
                        onBlur={() => void commitRename(active.sessionId)}
                        aria-label={t("terminal.rename")}
                      />
                    </span>
                  ) : (
                    <span
                      className="session-header__label"
                      onDoubleClick={
                        active.kind === "agent"
                          ? () => beginRename(active.sessionId, active.renameLabel)
                          : undefined
                      }
                      title={active.kind === "agent" ? t("terminal.renameHint") : undefined}
                    >
                      <ActiveGlyph size={13} />
                      <span className="truncate">
                        {active.kind === "agent"
                          ? active.headerLabel
                          : active.label}
                      </span>
                      {active.kind === "agent" && active.headerMemberLabel && (
                        <>
                          <span
                            className="session-header__member-sep"
                            aria-hidden="true"
                          >
                            ·
                          </span>
                          <span className="session-header__member truncate">
                            {active.headerMemberLabel}
                          </span>
                        </>
                      )}
                    </span>
                  )}
                </div>
                <div className="session-header__actions">
                  {active.kind === "agent" && editingTab !== active.sessionId && (
                    <>
                      <button
                        type="button"
                        className="icon-button icon-button--sm"
                        disabled={choosingRelocation}
                        onClick={() => void chooseRelocationDirectory(active)}
                        aria-label={t("terminal.directory.change")}
                        data-tooltip={t("terminal.directory.change")}
                      >
                        <FolderIcon size={12} />
                      </button>
                      <button
                        type="button"
                        className="icon-button icon-button--sm"
                        onClick={() =>
                          beginRename(active.sessionId, active.renameLabel)
                        }
                        aria-label={t("terminal.rename")}
                        data-tooltip={t("terminal.rename")}
                      >
                        <EditIcon size={12} />
                      </button>
                    </>
                  )}
                  {active.kind === "ssh" && (
                    <button
                      type="button"
                      className={`icon-button icon-button--sm session-header__files-button${
                        filesOpen[active.sessionId] ? " is-active" : ""
                      }`}
                      onClick={() => void toggleFiles(active.sessionId)}
                      aria-pressed={!!filesOpen[active.sessionId]}
                      aria-label={t("terminal.openFiles")}
                      data-tooltip={t("terminal.openFiles")}
                    >
                      <FolderIcon size={12} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-button icon-button--sm"
                    onClick={() => void close(active)}
                    aria-label={t("terminal.disconnect")}
                    data-tooltip={t("terminal.disconnect")}
                  >
                    <CloseIcon size={12} />
                  </button>
                </div>
              </header>
            );
          })()}

          <div className="terminal-stack">
        {agentGroups.map((group, groupIndex) => {
          const memberId = activeMemberId(group);
          const runningCount = group.members.filter(
            (member) => member.state === "working",
          ).length;
          const groupActive = group.members.some(
            (member) => member.sessionId === active.sessionId,
          );
          const installed = installedAgents;
          return (
            <div
              className="terminal-slot terminal-slot--cli"
              key={group.groupId}
              hidden={!groupActive}
            >
              <div
                className="cli-switch"
                role="tablist"
                aria-label={t("terminal.cliSwitch")}
              >
                {group.members.map((member, memberIndex) => {
                  const selected = member.sessionId === memberId;
                  const memberStatus = agentGroupSidebarStatus([member]);
                  const memberStatusLabel =
                    memberStatus === "working"
                      ? t("terminal.projects.status.working")
                      : memberStatus === "attention"
                        ? t("terminal.projects.status.attention")
                        : memberStatus === "done"
                          ? t("terminal.projects.status.done")
                          : memberStatus === "idle"
                            ? t("terminal.projects.status.idle")
                            : null;
                  return (
                    <span
                      key={member.sessionId}
                      className={`cli-switch__pill${selected ? " is-active" : ""}`}
                    >
                      <button
                        type="button"
                        id={`${sessionTabsId}-${groupIndex}-${memberIndex}-tab`}
                        role="tab"
                        aria-selected={selected}
                        aria-controls={`${sessionTabsId}-${groupIndex}-${memberIndex}-panel`}
                        tabIndex={selected ? 0 : -1}
                        className="cli-switch__select"
                        onClick={() =>
                          selectMember(group.groupId, member.sessionId)
                        }
                        onKeyDown={(event) =>
                          moveTabGroupFocus(event, memberIndex, (nextIndex) =>
                            selectMember(
                              group.groupId,
                              group.members[nextIndex].sessionId,
                            ),
                          )
                        }
                      >
                        {memberStatusLabel && (
                          <span
                            className={`cli-switch__status status-${memberStatus}`}
                            title={memberStatusLabel}
                            aria-label={memberStatusLabel}
                          />
                        )}
                        <AgentIcon size={12} />
                        <span className="cli-switch__identity">
                          <span className="truncate">{sessionCliLabel(member)}</span>
                          <span
                            className="cli-switch__model truncate"
                            title={
                              member.tokenUsage
                                ? t("agents.usage.breakdown", {
                                    input: tokenNumber.format(
                                      member.tokenUsage.inputTokens,
                                    ),
                                    output: tokenNumber.format(
                                      member.tokenUsage.outputTokens,
                                    ),
                                    cacheRead: tokenNumber.format(
                                      member.tokenUsage.cacheReadTokens,
                                    ),
                                    cacheWrite: tokenNumber.format(
                                      member.tokenUsage.cacheWriteTokens,
                                    ),
                                    reasoning: tokenNumber.format(
                                      member.tokenUsage.reasoningTokens,
                                    ),
                                  })
                                : undefined
                            }
                          >
                            {member.model ?? t("terminal.model.pending")}
                            {member.tokenUsage
                              ? ` · ${t("agents.usage.compact", {
                                  tokens: compactTokenNumber.format(
                                    member.tokenUsage.totalTokens,
                                  ),
                                })}`
                              : ""}
                          </span>
                        </span>
                      </button>
                      {group.members.length > 1 && (
                        <button
                          type="button"
                          className="cli-switch__close"
                          onClick={() =>
                            void closeAgentMember(group.members, member.sessionId)
                          }
                          aria-label={t("terminal.disconnect")}
                        >
                          <CloseIcon size={10} />
                        </button>
                      )}
                    </span>
                  );
                })}
                <div className="cli-switch__add-wrap">
                  <button
                    type="button"
                    className="cli-switch__add"
                    ref={
                      addCliFor === group.groupId ? addCliButtonRef : undefined
                    }
                    onClick={(event) => {
                      addCliButtonRef.current = event.currentTarget;
                      setSelectedAddModel(defaultModelSelection());
                      setAddCliFor((current) =>
                        current === group.groupId ? null : group.groupId,
                      );
                    }}
                    aria-haspopup="dialog"
                    aria-expanded={addCliFor === group.groupId}
                    aria-controls={
                      addCliFor === group.groupId
                        ? `${sessionTabsId}-${groupIndex}-add-cli-dialog`
                        : undefined
                    }
                  >
                    <PlusIcon size={12} />
                    <span>{t("terminal.addCli")}</span>
                  </button>
                  {addCliFor === group.groupId &&
                    (() => {
                      const source = group.members.find(
                        (member) => member.sessionId === memberId,
                      );
                      const canCarry = agents.catalog.some(
                        (definition) =>
                          definition.id === source?.definitionId &&
                          definition.transcriptSupported,
                      ) && !source?.closedReason;
                      const carry = canCarry && carryContext;
                      return (
                        <div
                          ref={addCliDialogRef}
                          id={`${sessionTabsId}-${groupIndex}-add-cli-dialog`}
                          className="cli-switch__menu"
                          role="dialog"
                          aria-label={t("terminal.addCli")}
                          tabIndex={-1}
                        >
                          {canCarry ? (
                            <>
                              <label className="cli-switch__carry">
                                <input
                                  type="checkbox"
                                  checked={carryContext}
                                  onChange={(event) =>
                                    setCarryContext(event.currentTarget.checked)
                                  }
                                />
                                <span>{t("terminal.handoff.carry")}</span>
                              </label>
                              <span className="cli-switch__menu-empty">
                                {t("terminal.handoff.directOrBrief")}
                              </span>
                            </>
                          ) : (
                            <span className="cli-switch__menu-empty">
                              {source?.closedReason
                                ? t("terminal.handoff.closed")
                                : t("terminal.handoff.unsupported")}
                            </span>
                          )}
                          <div className="cli-switch__menu-sep" />
                          <AccountModelField
                            options={modelOptions}
                            value={selectedAddModel}
                            onChange={setSelectedAddModel}
                          />
                          <button
                            type="button"
                            className="button button--primary button--sm"
                            disabled={!selectedAddModel || !modelOptions.some((option) => accountModelKey(option) === accountModelKey(selectedAddModel))}
                            onClick={() => selectedAddModel && void addCli(group, selectedAddModel, carry)}
                          >{t("terminal.projects.launch")}</button>
                          {installed.length === 0 && (
                            <span className="cli-switch__menu-empty">
                              {t("terminal.addCli.none")}
                            </span>
                          )}
                        </div>
                      );
                    })()}
                </div>
                {group.members.length > 1 && (
                  <span className="cli-switch__summary">
                    {t("terminal.cliSummary", {
                      count: group.members.length,
                      running: runningCount,
                    })}
                  </span>
                )}
              </div>
              <div className="cli-panes">
                {group.members.map((member, memberIndex) => (
                  <div
                    className="cli-pane-slot"
                    key={member.sessionId}
                    id={`${sessionTabsId}-${groupIndex}-${memberIndex}-panel`}
                    role="tabpanel"
                    aria-labelledby={`${sessionTabsId}-${groupIndex}-${memberIndex}-tab`}
                    hidden={member.sessionId !== memberId}
                  >
                    <AgentTerminalPane
                      sessionId={member.sessionId}
                      agents={agents}
                      theme={theme}
                    />
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        {ssh.sessions.map((session) => {
          const isActive = session.sessionId === active.sessionId;
          const sftpId = pairedSftp[session.sessionId];
          const sftpSession = sftpId
            ? sftp.sessions.find((entry) => entry.sessionId === sftpId)
            : undefined;
          const showFiles = !!filesOpen[session.sessionId] && !!sftpSession;
          return (
            <div
              className="terminal-slot terminal-slot--ssh"
              key={session.sessionId}
              hidden={!isActive}
            >
              {mobile && (
                <div className="ssh-pane-switch" role="group" aria-label={t("terminal.paneSwitch")}>
                  <button type="button" className="button button--ghost"
                    aria-pressed={!showFiles}
                    onClick={() => setFilesOpen((prev) => ({ ...prev, [session.sessionId]: false }))}>
                    <TerminalIcon size={16} /> {t("terminal.pane.terminal")}
                  </button>
                  <button type="button" className="button button--ghost"
                    aria-pressed={showFiles}
                    onClick={() => { if (!filesOpen[session.sessionId]) void toggleFiles(session.sessionId); }}>
                    <FolderIcon size={16} /> {t("terminal.pane.files")}
                  </button>
                </div>
              )}
              <div
                className={`ssh-split${showFiles ? " ssh-split--files" : ""}`}
              >
                {showFiles && sftpSession && (
                  <aside className="ssh-split__files">
                    <SftpPane
                      session={sftpSession}
                      sftp={sftp}
                      active={isActive}
                    />
                    {isActive && (
                      <div className="ssh-split__metrics">
                        <HostMetricsPanel
                          state={sshHostMetrics}
                          variant="compact"
                        />
                      </div>
                    )}
                  </aside>
                )}
                <div className="ssh-split__term">
                  <TerminalPane
                    mobile={mobile}
                    sessionId={session.sessionId}
                    ssh={ssh}
                    theme={theme}
                    onClosed={() => {
                      if (
                        shouldClearSessionSelection(
                          active.sessionId,
                          session.sessionId,
                        )
                      ) {
                        onSelect(null);
                      }
                    }}
                  />
                </div>
              </div>
            </div>
          );
        })}
        {sftp.sessions
          .filter((session) => !pairedSftpIds.has(session.sessionId))
          .map((session) => (
            <div
              className="terminal-slot"
              key={session.sessionId}
              hidden={session.sessionId !== active.sessionId}
            >
              <SftpPane
                session={session}
                sftp={sftp}
                active={session.sessionId === active.sessionId}
              />
            </div>
          ))}
        {remote.sessions.map((session) => (
          <div
            className="terminal-slot"
            key={session.sessionId}
            hidden={session.sessionId !== active.sessionId}
          >
            <RemotePane session={session} remote={remote} theme={theme} />
          </div>
        ))}
        {rdp.sessions.map((session) => (
          <div
            className="terminal-slot"
            key={session.sessionId}
            hidden={session.sessionId !== active.sessionId}
          >
            <RdpPane session={session} rdp={rdp} />
          </div>
        ))}
        {vnc.sessions.map((session) => (
          <div
            className="terminal-slot"
            key={session.sessionId}
            hidden={session.sessionId !== active.sessionId}
          >
            <VncPane session={session} vnc={vnc} />
          </div>
        ))}
          </div>
        </section>
      </div>
      {newProjectDialog}
      {folderDialog}
      {relocationDialog}
      {workspaceImportDialog}
      {clearWorkspaceDialog}
      {pendingDeleteFolder && (
        <ConfirmDialog
          title={t("terminal.projects.folderDeleteTitle", {
            name: pendingDeleteFolder.name,
          })}
          body={t("terminal.projects.folderDeleteBody")}
          confirmLabel={t("terminal.projects.folderDeleteAction")}
          cancelLabel={t("common.cancel")}
          onCancel={() => setPendingDeleteFolder(null)}
          onConfirm={() => {
            updateSidebarLayout((layout) =>
              removeSessionSidebarFolder(layout, pendingDeleteFolder.id),
            );
            setPendingDeleteFolder(null);
          }}
        />
      )}
      {pendingRemoveSession && (
        <ConfirmDialog
          title={t("terminal.projects.sessionRemoveTitle", {
            name: pendingRemoveSession.label,
          })}
          body={
            removeSessionError
              ? t("terminal.projects.sessionRemoveFailed", {
                  detail: removeSessionError,
                })
              : t("terminal.projects.sessionRemoveBody")
          }
          confirmLabel={t("terminal.projects.sessionRemoveAction")}
          cancelLabel={t("common.cancel")}
          confirmDisabled={removingSession}
          busy={removingSession}
          onCancel={() => {
            if (removingSession) return;
            setPendingRemoveSession(null);
            setRemoveSessionError(null);
          }}
          onConfirm={() => {
            if (removingSession) return;
            setRemovingSession(true);
            setRemoveSessionError(null);
            void removeSession(pendingRemoveSession)
              .then(() => setPendingRemoveSession(null))
              .catch((reason) =>
                setRemoveSessionError(
                  reason instanceof Error ? reason.message : String(reason),
                ),
              )
              .finally(() => setRemovingSession(false));
          }}
        />
      )}
    </div>
  );
}
