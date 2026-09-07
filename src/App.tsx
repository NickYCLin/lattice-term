/**
 * Application shell.
 *
 * Rail, sidebar, workspace column and status bar. This file owns navigation,
 * overlays and shortcuts; the data lives in `useWorkspace`, the language in
 * `I18nProvider`, and each area renders its own view.
 */

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  findNavigationItem,
  isMobilePlatform,
  navigationItemsFor,
  type ViewId,
} from "./app/navigation";
import {
  canConnectProtocol,
  canUseInAppUpdater,
  workspaceHeaderCapabilities,
} from "./app/platformCapabilities";
import {
  usePreferences,
  type Preferences,
  type PreferencesValue,
} from "./app/preferences";
import type { EncryptedBackupRestore } from "./app/encryptedBackup";
import { rememberRelayDevice } from "./app/rememberRelayDevice";
import { saveRelayAddress } from "./app/remoteRelay";
import { findTheme, themeCatalog } from "./app/themes";
import { useViewMotion } from "./app/useViewMotion";
import { useRuntimeSummary } from "./app/useRuntimeSummary";
import { APP_VERSION } from "./app/version";
import { useStorageStatus } from "./app/useStorageStatus";
import { useAgentSessions } from "./app/useAgentSessions";
import { useAgentActivity } from "./app/useAgentActivity";
import type { ChatRuntimeApi } from "./app/ChatRuntime";
import { useSshSessions } from "./app/useSshSessions";
import { useSftpSessions } from "./app/useSftpSessions";
import { useRemoteSessions } from "./app/useRemoteSessions";
import { useRemoteHost } from "./app/useRemoteHost";
import { useRdpSessions } from "./app/useRdpSessions";
import { useVncSessions } from "./app/useVncSessions";
import { useVault } from "./app/useVault";
import { useVaultAutoLock } from "./app/useVaultAutoLock";
import { useWindowTheme } from "./app/useWindowTheme";
import { useWorkspace } from "./app/useWorkspace";
import { useCredentialDeleteGuard } from "./app/useSavedCredential";
import {
  draftFromProfile,
  type ConnectionDraft,
  type ConnectionProfile,
} from "./domain/connection";
import { I18nProvider } from "./i18n";
import { useI18n } from "./i18n/context";
import { localeCatalog } from "./i18n/catalog";
import { NavRail } from "./components/shell/NavRail";
import { ResourceSidebar } from "./components/shell/ResourceSidebar";
import { StatusBar } from "./components/shell/StatusBar";
import { ViewHeader } from "./components/shell/ViewHeader";
import { ConnectionInspector } from "./components/connections/ConnectionInspector";
import { useHostMetrics } from "./app/useHostMetrics";
import type { Command } from "./components/overlays/CommandPalette";
import { ConfirmDialog } from "./components/overlays/ConfirmDialog";
import { DesktopBackendRequiredDialog } from "./components/overlays/DesktopBackendRequiredDialog";
import { UpdatePrompt } from "./components/overlays/UpdatePrompt";
import { useAppUpdater } from "./app/useAppUpdater";
import {
  agentFreshLaunchArguments,
  agentRestoreArguments,
  loadWorkspaceSessionSnapshot,
  preserveUnrestoredWorkspaceSessions,
  saveWorkspaceSessionSnapshot,
  snapshotLiveWorkspaceSessions,
  type SavedWorkspaceSession,
} from "./app/workspaceSessionPersistence";
import { loadAuthPref } from "./app/authPreferences";
import {
  playNotificationSound,
  prepareNotificationAudio,
} from "./app/notificationSounds";
import { anyAgentSessionJustCompleted } from "./app/sessionStatus";
import { PlusIcon, ScreenShareIcon } from "./components/icons";
import { useModalFocus } from "./components/overlays/modalFocus";
import "./styles/index.css";

const ConnectionsView = lazy(() =>
  import("./views/ConnectionsView").then((module) => ({
    default: module.ConnectionsView,
  })),
);
const AgentsView = lazy(() =>
  import("./views/AgentsView").then((module) => ({
    default: module.AgentsView,
  })),
);
const ChatRuntime = lazy(() =>
  import("./app/ChatRuntime").then((module) => ({
    default: module.ChatRuntime,
  })),
);
const ChatView = lazy(() =>
  import("./views/ChatView").then((module) => ({
    default: module.ChatView,
  })),
);
const SessionsView = lazy(() =>
  import("./views/SessionsView").then((module) => ({
    default: module.SessionsView,
  })),
);
const ActivityView = lazy(() =>
  import("./views/ActivityView").then((module) => ({
    default: module.ActivityView,
  })),
);
const VaultView = lazy(() =>
  import("./views/VaultView").then((module) => ({
    default: module.VaultView,
  })),
);
const TunnelsView = lazy(() =>
  import("./views/TunnelsView").then((module) => ({
    default: module.TunnelsView,
  })),
);
const SettingsView = lazy(() =>
  import("./views/SettingsView").then((module) => ({
    default: module.SettingsView,
  })),
);
const CommandPalette = lazy(() =>
  import("./components/overlays/CommandPalette").then((module) => ({
    default: module.CommandPalette,
  })),
);
const ConnectionDrawer = lazy(() =>
  import("./components/overlays/ConnectionDrawer").then((module) => ({
    default: module.ConnectionDrawer,
  })),
);
const ConnectFlow = lazy(() =>
  import("./components/terminal/ConnectFlow").then((module) => ({
    default: module.ConnectFlow,
  })),
);
const RemoteConnectFlow = lazy(() =>
  import("./components/remote/RemoteConnectFlow").then((module) => ({
    default: module.RemoteConnectFlow,
  })),
);
const RdpConnectFlow = lazy(() =>
  import("./components/rdp/RdpConnectFlow").then((module) => ({
    default: module.RdpConnectFlow,
  })),
);
const VncConnectFlow = lazy(() =>
  import("./components/vnc/VncConnectFlow").then((module) => ({
    default: module.VncConnectFlow,
  })),
);
const RemoteHostDialog = lazy(() =>
  import("./components/remote/RemoteHostDialog").then((module) => ({
    default: module.RemoteHostDialog,
  })),
);
const RemoteQuickConnect = lazy(() =>
  import("./components/remote/RemoteQuickConnect").then((module) => ({
    default: module.RemoteQuickConnect,
  })),
);
const SftpConnectFlow = lazy(() =>
  import("./components/sftp/SftpConnectFlow").then((module) => ({
    default: module.SftpConnectFlow,
  })),
);

const NO_SUPPORTED_PROTOCOLS: readonly string[] = [];

function LazyViewFallback() {
  const { t } = useI18n();
  return (
    <div className="empty-state" role="status" aria-live="polite">
      <span className="panel__hint">{t("common.loading")}</span>
    </div>
  );
}

function LazyOverlayFallback() {
  const { t } = useI18n();
  return (
    <div className="scrim scrim--center" role="status" aria-live="polite">
      <div className="dialog">
        <p className="dialog__body">{t("common.loading")}</p>
      </div>
    </div>
  );
}

function Workspace({ preferences, update, activeTheme }: PreferencesValue) {
  const { t } = useI18n();
  const workspace = useWorkspace();
  const runtime = useRuntimeSummary();
  const platform = runtime.summary?.platform;
  const onMobile = isMobilePlatform(platform);
  const supportedProtocols =
    runtime.summary?.supportedProtocols ?? NO_SUPPORTED_PROTOCOLS;
  const headerCapabilities = workspaceHeaderCapabilities(platform);
  const inAppUpdaterAvailable = canUseInAppUpdater(runtime.host, platform);
  const visibleNavigation = navigationItemsFor(platform);
  const storage = useStorageStatus();
  const agents = useAgentSessions();
  const ssh = useSshSessions();
  const sftp = useSftpSessions();
  const remote = useRemoteSessions();
  const remoteHost = useRemoteHost();
  const rdp = useRdpSessions();
  const vnc = useVncSessions();
  const vault = useVault();

  // Completion notifications belong to the application shell, not the lazy
  // terminal view. This keeps the listener alive when a CLI is launched from
  // Agent Fleet and finishes before the terminal workspace has loaded.
  const completionStates = agents.sessions
    .map((session) => `${session.sessionId}:${session.state}`)
    .join("|");
  const previousCompletionStatesRef = useRef<
    Map<string, (typeof agents.sessions)[number]["state"]> | null
  >(null);
  useEffect(() => {
    if (agents.mode !== "ready") {
      previousCompletionStatesRef.current = null;
      return;
    }

    const current = new Map(
      agents.sessions.map((session) => [session.sessionId, session.state]),
    );
    const previous = previousCompletionStatesRef.current;
    if (anyAgentSessionJustCompleted(previous, agents.sessions)) {
      void playNotificationSound(preferences.agentCompletionSound);
    }
    previousCompletionStatesRef.current = current;
  }, [agents.mode, completionStates, preferences.agentCompletionSound]);

  useEffect(() => {
    let unlocked = false;
    const prepare = () => {
      if (unlocked) return;
      void prepareNotificationAudio().then((ready) => {
        if (!ready) return;
        unlocked = true;
        window.removeEventListener("pointerdown", prepare, true);
        window.removeEventListener("keydown", prepare, true);
      });
    };
    window.addEventListener("pointerdown", prepare, true);
    window.addEventListener("keydown", prepare, true);
    return () => {
      window.removeEventListener("pointerdown", prepare, true);
      window.removeEventListener("keydown", prepare, true);
    };
  }, []);

  useVaultAutoLock(preferences, vault);

  useWindowTheme(findTheme(activeTheme).isDark);

  // Auto-check for a newer release on launch (desktop only) and, when one is
  // found, surface it up front instead of leaving it buried in Settings.
  const updater = useAppUpdater(runtime.summary?.version);
  const [updatePromptDismissed, setUpdatePromptDismissed] = useState(false);
  const launchCheckedRef = useRef(false);
  const { checkForUpdates } = updater;
  useEffect(() => {
    if (launchCheckedRef.current) return;
    if (!inAppUpdaterAvailable) return;
    if (!runtime.summary) return;
    if (!preferences.checkUpdatesOnLaunch) return;
    launchCheckedRef.current = true;
    void checkForUpdates();
  }, [
    inAppUpdaterAvailable,
    runtime.summary,
    preferences.checkUpdatesOnLaunch,
    checkForUpdates,
  ]);
  const showUpdatePrompt =
    !updatePromptDismissed &&
    inAppUpdaterAvailable &&
    (updater.status === "available" ||
      updater.status === "downloading" ||
      updater.status === "installing" ||
      updater.status === "downloaded" ||
      (updater.status === "error" && updater.availableVersion !== null));

  const [view, setView] = useState<ViewId>("connections");
  const activityReturnViewRef = useRef<ViewId>("connections");
  const agentActivity = useAgentActivity(agents.sessions, agents.mode);
  // Chat state lives at the root (a reply keeps streaming and a schedule
  // keeps firing while another view is open) but loads lazily, so its code
  // stays out of the entry bundle.
  const [chatRuntime, setChatRuntime] = useState<ChatRuntimeApi | null>(null);
  const [mobileResourceSidebarOpen, setMobileResourceSidebarOpen] =
    useState(false);
  // A desktop-only view reached on mobile (stale state) snaps back home.
  useEffect(() => {
    if (onMobile && !visibleNavigation.some((entry) => entry.id === view)) {
      setView("connections");
    }
  }, [onMobile, view, visibleNavigation]);
  useEffect(() => {
    if (!onMobile || view !== "connections") {
      setMobileResourceSidebarOpen(false);
    }
  }, [onMobile, view]);
  const sidebarExpanded = onMobile
    ? mobileResourceSidebarOpen
    : !preferences.sidebarCollapsed;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawer, setDrawer] = useState<{
    open: boolean;
    profileId: string | null;
  }>({ open: false, profileId: null });
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [removingProfile, setRemovingProfile] = useState(false);
  const [profileDeleteError, setProfileDeleteError] = useState<string | null>(
    null,
  );
  const [remoteHostOpen, setRemoteHostOpen] = useState(false);
  const [quickConnectOpen, setQuickConnectOpen] = useState(false);
  const [connectTarget, setConnectTarget] = useState<ConnectionProfile | null>(
    null,
  );
  const mobileDesktopDialogRef = useRef<HTMLDivElement>(null);
  const mobileDesktopCloseRef = useRef<HTMLButtonElement>(null);
  const mobileDesktopDialogOpen =
    runtime.host === "tauri" &&
    connectTarget !== null &&
    onMobile &&
    (connectTarget.protocol === "rdp" || connectTarget.protocol === "vnc");
  useModalFocus({
    dialogRef: mobileDesktopDialogRef,
    getInitialFocus: () => mobileDesktopCloseRef.current,
    onEscape: () => setConnectTarget(null),
    active: mobileDesktopDialogOpen,
  });
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [terminalMounted, setTerminalMounted] = useState(false);
  const storedSessionSnapshotRef = useRef(
    loadWorkspaceSessionSnapshot(window.localStorage),
  );
  const restoredWorkspaceSessions = useMemo(
    () => storedSessionSnapshotRef.current?.sessions ?? [],
    [],
  );
  const [unrestoredWorkspaceSessions, setUnrestoredWorkspaceSessions] = useState(
    restoredWorkspaceSessions,
  );
  const unrestoredSessionsRef = useRef<readonly SavedWorkspaceSession[]>([]);
  const restoreStartedRef = useRef(false);
  const [sessionRestoreComplete, setSessionRestoreComplete] = useState(false);

  // Opening an Agent terminal is the equivalent of reading its Activity row.
  // Include unreadCount so a completion that arrives while this tab is already
  // visible is acknowledged without requiring the user to switch away first.
  useEffect(() => {
    if (view !== "terminal" || !activeSessionId) return;
    const activeAgent = agents.sessions.find(
      (session) => session.sessionId === activeSessionId,
    );
    if (!activeAgent) return;
    agentActivity.markGroupRead(
      activeAgent.groupId || activeAgent.sessionId,
    );
  }, [
    activeSessionId,
    agentActivity.markGroupRead,
    agentActivity.unreadCount,
    agents.sessions,
    view,
  ]);

  // A process cannot survive an application or machine restart. Recreate the
  // safe launch intent instead: agent type/directory/group label, and opaque
  // SSH profile IDs whose actual credentials remain in the OS credential
  // store. A WebView reload sees the backend's existing sessions and skips
  // relaunching them, preventing duplicates during development or recovery.
  useEffect(() => {
    if (restoreStartedRef.current) return;
    if (agents.mode === "loading" || !workspace.hydrated || !ssh.hydrated) return;
    restoreStartedRef.current = true;

    void (async () => {
      try {
        const snapshot = storedSessionSnapshotRef.current;
        const unrestored: SavedWorkspaceSession[] = [];
        const restoredAgents = [...agents.sessions];
        const restoredSsh = [...ssh.sessions];

        // Sessions the background service still holds re-attach by themselves;
        // only the desktop-owned ones decide whether saved tabs need restoring.
        if (snapshot && agents.sessions.every((session) => session.detached)) {
          const renamedGroups = new Set<string>();
          for (const saved of snapshot.sessions) {
            if (saved.kind !== "agent") continue;
            try {
              const freshArguments = agentFreshLaunchArguments(saved);
              const restoreArguments = agentRestoreArguments(saved);
              const attemptedContinuation =
                saved.resumeSessionId !== null ||
                restoreArguments.length !== freshArguments.length ||
                restoreArguments.some(
                  (argument, index) => argument !== freshArguments[index],
                );
              const launched = await agents.launch({
                definitionId: saved.definitionId,
                label: saved.label,
                executable: saved.executable,
                arguments: restoreArguments,
                resumeSessionId: saved.resumeSessionId,
                groupId: saved.groupKey,
                seedInput: null,
                restoreExistingSession: true,
                profileConfigPath: saved.profileConfigPath ?? null,
                sandbox: saved.sandbox === true,
                workingDirectory: saved.workingDirectory,
                cols: 120,
                rows: 32,
              });
              restoredAgents.push(launched);
              if (attemptedContinuation && launched.closedReason) {
                // A provider can reject an expired native conversation id.
                // Its latest-conversation flag can fail in the same way when
                // the project has no compatible history. Keep the diagnostic
                // tab, then give the project a fresh interactive CLI.
                try {
                  const fallback = await agents.launch({
                    definitionId: saved.definitionId,
                    label: saved.label,
                    executable: saved.executable,
                    arguments: freshArguments,
                    resumeSessionId: null,
                    groupId: saved.groupKey,
                    seedInput: null,
                    restoreExistingSession: false,
                    profileConfigPath: saved.profileConfigPath ?? null,
                    sandbox: saved.sandbox === true,
                    workingDirectory: saved.workingDirectory,
                    cols: 120,
                    rows: 32,
                  });
                  restoredAgents.push(fallback);
                  if (fallback.closedReason) {
                    unrestored.push({ ...saved, resumeSessionId: null });
                  } else if (!renamedGroups.has(saved.groupKey)) {
                    renamedGroups.add(saved.groupKey);
                    try {
                      await agents.rename(fallback.sessionId, saved.groupLabel);
                    } catch {
                      // The fresh terminal remains usable even if its saved
                      // tab label cannot be restored right now.
                    }
                  }
                } catch {
                  // Do not retry the same known-bad native id on the next
                  // restart. Keep a fresh launch intent for a later retry.
                  unrestored.push({ ...saved, resumeSessionId: null });
                }
                continue;
              }
              if (launched.closedReason) {
                unrestored.push(saved);
                continue;
              }
              if (!renamedGroups.has(saved.groupKey)) {
                renamedGroups.add(saved.groupKey);
                await agents.rename(launched.sessionId, saved.groupLabel);
              }
            } catch {
              // A removed directory/CLI or an expired provider entitlement must
              // not block the remaining workspace from coming back. Keep the
              // entry for a later retry instead of overwriting it with an
              // empty workspace snapshot below.
              unrestored.push(saved);
            }
          }
        }

        if (snapshot && ssh.sessions.length === 0) {
          for (const saved of snapshot.sessions) {
            if (saved.kind !== "ssh") continue;
            const profile = workspace.profiles.find(
              (candidate) =>
                candidate.id === saved.profileId && candidate.protocol === "ssh",
            );
            if (!profile) continue;
            try {
              const authPref = loadAuthPref(profile.id);
              const usingKey = authPref?.method === "privateKey";
              const outcome = await ssh.connect({
                profileId: profile.id,
                hostname: profile.hostname,
                port: profile.port,
                username: profile.username,
                auth: usingKey
                  ? {
                      kind: "privateKey",
                      path: authPref.keyPath,
                    }
                  : { kind: "password", password: "" },
                useSavedPassword: !usingKey,
                rememberPassword: false,
                cols: 120,
                rows: 32,
              });
              if (outcome.outcome === "connected") {
                restoredSsh.push({
                  sessionId: outcome.sessionId,
                  profileId: profile.id,
                  host: profile.hostname,
                  port: profile.port,
                  username: profile.username,
                });
              }
            } catch {
              // A missing OS credential or an unavailable host should not
              // prevent the rest of the saved workspace from restoring.
              unrestored.push(saved);
            }
          }
        }

        const savedActive = snapshot?.active;
        if (savedActive?.kind === "agent") {
          const matching = restoredAgents.filter(
            (session) =>
              session.groupId === savedActive.groupKey &&
              session.definitionId === savedActive.definitionId &&
              (session.profileConfigPath ?? null) === (savedActive.profileConfigPath ?? null),
          );
          const match =
            matching.find((session) => !session.closedReason) ?? matching[0];
          if (match) setActiveSessionId(match.sessionId);
        } else if (savedActive?.kind === "ssh") {
          const match = restoredSsh.find(
            (session) => session.profileId === savedActive.profileId,
          );
          if (match) setActiveSessionId(match.sessionId);
        }

        setUnrestoredWorkspaceSessions(unrestored);
        if (
          restoredAgents.length > 0 ||
          restoredSsh.length > 0 ||
          unrestored.some((session) => session.kind === "agent")
        ) {
          setView("terminal");
          setTerminalMounted(true);
        }
        unrestoredSessionsRef.current = unrestored;
      } finally {
        // Even a provider-specific failure must release persistence so new
        // sessions opened during this run become the next restore snapshot.
        setSessionRestoreComplete(true);
      }
    })();
  }, [agents, ssh, workspace]);

  useEffect(() => {
    if (!sessionRestoreComplete) return;
    try {
      const live = snapshotLiveWorkspaceSessions(
          agents.sessions,
          ssh.sessions,
          activeSessionId,
        );
      saveWorkspaceSessionSnapshot(
        window.localStorage,
        preserveUnrestoredWorkspaceSessions(
          live,
          unrestoredSessionsRef.current,
          storedSessionSnapshotRef.current?.active ?? null,
        ),
      );
    } catch {
      // Session restoration is a convenience. A full WebView storage area
      // must never prevent a live terminal from continuing to work.
    }
  }, [
    activeSessionId,
    agents.sessions,
    sessionRestoreComplete,
    ssh.sessions,
  ]);
  const hasLiveSessions =
    agents.sessions.length > 0 ||
    ssh.sessions.length > 0 ||
    sftp.sessions.length > 0 ||
    remote.sessions.length > 0 ||
    rdp.sessions.length > 0 ||
    vnc.sessions.length > 0;

  // The terminal workspace is expensive because it owns xterm and every
  // remote-canvas renderer. Load it only when first needed, then keep it
  // mounted so switching views never discards terminal or canvas contents.
  useEffect(() => {
    if (view === "terminal" || hasLiveSessions) setTerminalMounted(true);
  }, [hasLiveSessions, view]);

  const searchRef = useRef<HTMLInputElement>(null);

  const {
    profiles,
    visibleProfiles,
    groups,
    tags,
    filter,
    filterActive,
    setFilter,
    resetFilter,
    selected,
    setSelectedId,
    addProfile,
    updateProfile,
    duplicateProfile,
    removeProfile,
    loadSamples,
  } = workspace;

  const editing = useMemo(
    () => profiles.find((entry) => entry.id === drawer.profileId) ?? null,
    [profiles, drawer.profileId],
  );

  const deleting = useMemo(
    () => profiles.find((entry) => entry.id === pendingDelete) ?? null,
    [profiles, pendingDelete],
  );
  const deleteGuard = useCredentialDeleteGuard(deleting);

  const requestDelete = useCallback((id: string) => {
    setProfileDeleteError(null);
    setPendingDelete(id);
  }, []);

  const openCreate = useCallback(() => {
    setView("connections");
    setMobileResourceSidebarOpen(false);
    setDrawer({ open: true, profileId: null });
  }, []);

  const openEdit = useCallback((id: string) => {
    setView("connections");
    setMobileResourceSidebarOpen(false);
    setDrawer({ open: true, profileId: id });
  }, []);

  const toggleResourceSidebar = useCallback(() => {
    if (onMobile) {
      setView("connections");
      setMobileResourceSidebarOpen((open) => !open);
      return;
    }
    update({ sidebarCollapsed: !preferences.sidebarCollapsed });
  }, [onMobile, preferences.sidebarCollapsed, update]);

  const focusSearch = useCallback(() => {
    setView("connections");
    if (onMobile) setMobileResourceSidebarOpen(true);
    else update({ sidebarCollapsed: false });
    window.setTimeout(() => searchRef.current?.focus(), 0);
  }, [onMobile, update]);

  const saveDraft = useCallback(
    (draft: ConnectionDraft, connectAfterSave: boolean) => {
      const saved = drawer.profileId
        ? updateProfile(drawer.profileId, draft)
        : addProfile(draft);
      setDrawer({ open: false, profileId: null });
      if (
        connectAfterSave &&
        canConnectProtocol(saved.protocol, supportedProtocols)
      ) {
        setConnectTarget(saved);
      }
    },
    [drawer.profileId, addProfile, supportedProtocols, updateProfile],
  );


  const applyRestoredBackup = useCallback(
    async (
      result: EncryptedBackupRestore,
      restoredPreferences: Preferences,
    ) => {
      update(restoredPreferences);
      await Promise.all([
        workspace.refreshProfiles(),
        agents.refreshCatalog(),
        vault.refresh(),
      ]);
      storage.refresh();
      workspace.logActivity({
        type: "workspace",
        message: t("settings.backup.activity"),
        detail: t("settings.backup.restored", {
          profiles: result.profileCount,
          hosts: result.trustedHostCount,
          plans: result.agentPlanCount,
        }),
      });
    },
    [agents, storage, t, update, vault, workspace],
  );

  const commands = useMemo<Command[]>(() => {
    const entries: Command[] = visibleNavigation.map((item) => ({
      id: `view:${item.id}`,
      label: t("palette.goTo", { name: t(item.labelKey) }),
      hint: t(item.descriptionKey),
      group: t("palette.group.navigate"),
      run: () => setView(item.id),
    }));

    entries.push(
      {
        id: "action:new",
        label: t("palette.command.add"),
        hint: t("palette.command.addHint"),
        group: t("palette.group.actions"),
        keys: ["N"],
        run: openCreate,
      },
      {
        id: "action:search",
        label: t("palette.command.search"),
        hint: t("palette.command.searchHint"),
        group: t("palette.group.actions"),
        keys: ["/"],
        run: focusSearch,
      },
    );

    if (profiles.length === 0) {
      entries.push({
        id: "action:samples",
        label: t("palette.command.samples"),
        hint: t("palette.command.samplesHint"),
        group: t("palette.group.actions"),
        run: () => {
          void loadSamples();
        },
      });
    }

    // Every theme is reachable from the keyboard, not only the two-way toggle.
    for (const theme of themeCatalog) {
      if (theme.id === preferences.theme) continue;
      entries.push({
        id: `theme:${theme.id}`,
        label: t("palette.command.theme", { name: t(theme.labelKey) }),
        group: t("palette.group.appearance"),
        run: () => update({ theme: theme.id }),
      });
    }

    for (const locale of localeCatalog) {
      if (locale.id === preferences.locale) continue;
      entries.push({
        id: `locale:${locale.id}`,
        label: t("palette.command.language", { name: locale.label }),
        group: t("palette.group.appearance"),
        run: () => update({ locale: locale.id }),
      });
    }

    entries.push(
      {
        id: "action:density",
        label: t("palette.command.density", {
          name:
            preferences.density === "compact"
              ? t("settings.density.comfortable")
              : t("settings.density.compact"),
        }),
        group: t("palette.group.appearance"),
        run: () =>
          update({
            density:
              preferences.density === "compact" ? "comfortable" : "compact",
          }),
      },
      {
        id: "action:sidebar",
        label: sidebarExpanded
          ? t("palette.command.sidebar.hide")
          : t("palette.command.sidebar.show"),
        group: t("palette.group.appearance"),
        keys: ["Ctrl", "B"],
        run: toggleResourceSidebar,
      },
    );

    return entries;
  }, [
    t,
    openCreate,
    focusSearch,
    update,
    preferences.theme,
    preferences.locale,
    preferences.density,
    sidebarExpanded,
    profiles.length,
    loadSamples,
    toggleResourceSidebar,
    visibleNavigation,
  ]);

  // Global shortcuts. Anything typed into a field is left alone.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable === true;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        toggleResourceSidebar();
        return;
      }

      if (
        (event.ctrlKey || event.metaKey) &&
        event.altKey &&
        event.key.toLowerCase() === "u"
      ) {
        event.preventDefault();
        setView((current) => {
          if (current === "activity") return activityReturnViewRef.current;
          activityReturnViewRef.current = current;
          return "activity";
        });
        return;
      }

      if (typing || event.ctrlKey || event.metaKey || event.altKey) return;

      if (event.key === "/") {
        event.preventDefault();
        focusSearch();
      } else if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        openCreate();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focusSearch, openCreate, toggleResourceSidebar]);

  const item = findNavigationItem(view);
  const workspaceMotionRef = useViewMotion(view, preferences.motion);
  const showSidebar = view === "connections" && sidebarExpanded;
  const showInspector =
    view === "connections" && selected !== null && preferences.inspectorOpen;
  // Read resources only while the inspector can show them; passing null stops
  // the polling the moment the panel closes.
  const inspectorMetrics = useHostMetrics(
    showInspector ? selected : null,
    ssh.sessions,
  );

  return (
    <div className={`app${onMobile ? " app--mobile" : ""}`}>
      <NavRail
        current={view}
        onSelect={(next) => {
          if (next === "activity" && view !== "activity") {
            activityReturnViewRef.current = view;
          }
          setView(next);
        }}
        items={visibleNavigation}
        activityUnreadCount={agentActivity.unreadCount}
      />

      {showSidebar && (
        <ResourceSidebar
          ref={searchRef}
          filter={filter}
          onFilterChange={setFilter}
          onReset={resetFilter}
          filterActive={filterActive}
          groups={groups}
          tags={tags}
          totalCount={profiles.length}
          favoriteCount={profiles.filter((entry) => entry.favorite).length}
          visibleCount={visibleProfiles.length}
          mobileOpen={onMobile && mobileResourceSidebarOpen}
          onMobileClose={() => setMobileResourceSidebarOpen(false)}
        />
      )}

      <main className="workspace">
        <ViewHeader
          title={t(item.labelKey)}
          description={t(item.descriptionKey)}
          sidebarCollapsed={!sidebarExpanded}
          sidebarIsDialog={onMobile}
          showSidebarToggle={view === "connections"}
          onToggleSidebar={toggleResourceSidebar}
          actions={
            <>
              {headerCapabilities.remoteQuickConnect && (
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={() => setQuickConnectOpen(true)}
                >
                  <ScreenShareIcon size={15} />
                  {t("remote.quick.action")}
                </button>
              )}
              {headerCapabilities.remoteHost && (
                <button
                  type="button"
                  className={
                    remoteHost.status
                      ? "button button--secondary"
                      : "button button--ghost"
                  }
                  onClick={() => setRemoteHostOpen(true)}
                >
                  <ScreenShareIcon size={15} />
                  {t(
                    remoteHost.status
                      ? "remote.host.activeAction"
                      : "remote.host.action",
                  )}
                </button>
              )}
              {view === "connections" && profiles.length > 0 && (
                <button
                  type="button"
                  className="button button--primary"
                  onClick={openCreate}
                >
                  <PlusIcon size={15} />
                  {t("connections.add")}
                </button>
              )}
            </>
          }
        />

        <div className="workspace__body">
          <div ref={workspaceMotionRef} className="workspace__content glass glass--sheen">
            <Suspense fallback={<LazyViewFallback />}>
              {view === "connections" && (
                <ConnectionsView
                  workspace={workspace}
                  onCreate={openCreate}
                  onEdit={openEdit}
                  onDelete={requestDelete}
                  onConnect={setConnectTarget}
                  supportedProtocols={supportedProtocols}
                  backendAvailable={runtime.host === "tauri"}
                  mobile={onMobile}
                  platform={platform}
                />
              )}
            </Suspense>
            {/* Sessions load on first use, then stay mounted while other
                views are open: a terminal or remote canvas that unmounts loses
                everything it has drawn, and nothing replays it. Keep this in
                its own Suspense boundary so loading another view cannot reset
                an active xterm or canvas. */}
            {(terminalMounted || view === "terminal" || hasLiveSessions) && (
              <Suspense
                fallback={view === "terminal" ? <LazyViewFallback /> : null}
              >
                <div
                  hidden={view !== "terminal"}
                  style={{
                    display: view === "terminal" ? "contents" : "none",
                  }}
                >
                  <SessionsView
                    agents={agents}
                    ssh={ssh}
                    sftp={sftp}
                    remote={remote}
                    rdp={rdp}
                    vnc={vnc}
                    activeSessionId={activeSessionId}
                    onSelect={setActiveSessionId}
                    theme={activeTheme}
                    sessionRestoreComplete={sessionRestoreComplete}
                    restoredWorkspaceSessions={restoredWorkspaceSessions}
                    unrestoredWorkspaceSessions={unrestoredWorkspaceSessions}
                  />
                </div>
              </Suspense>
            )}
            <Suspense fallback={<LazyViewFallback />}>
            {view === "agents" && (
              <AgentsView
                agents={agents}
                remote={remote}
                sandboxAvailable={runtime.summary?.agentSandboxAvailable === true}
                onOpen={(sessionId) => {
                  setActiveSessionId(sessionId);
                  setView("terminal");
                }}
              />
            )}
            <Suspense fallback={null}>
              <ChatRuntime locale={preferences.locale} onChange={setChatRuntime} />
            </Suspense>
            {view === "chat" && chatRuntime && (
              <ChatView
                agents={agents}
                chat={chatRuntime.chat}
                automations={chatRuntime.automations}
              />
            )}
            {view === "tunnels" && (
              // Tunnels authenticate with a saved SSH password, so only SSH
              // profiles can serve as the gateway; offering an RDP or Lattice
              // profile here would fail at start every time.
              <TunnelsView
                profiles={profiles.filter((entry) => entry.protocol === "ssh")}
                backendAvailable={runtime.host === "tauri"}
              />
            )}
            {view === "vault" && (
              <VaultView workspace={workspace} vault={vault} />
            )}
            {view === "activity" && (
              <ActivityView
                workspace={workspace}
                agentActivity={agentActivity}
                onOpenAgentActivity={(groupId, sessionId) => {
                  agentActivity.markGroupRead(groupId);
                  if (!sessionId) return;
                  setActiveSessionId(sessionId);
                  setView("terminal");
                }}
              />
            )}
            {view === "settings" && (
              <SettingsView
                preferences={preferences}
                onChange={update}
                runtime={runtime}
                storage={storage}
                vaultUnlocked={vault.status?.state === "unlocked"}
                onBackupRestored={applyRestoredBackup}
                updater={updater}
              />
            )}
            </Suspense>
          </div>

          {showInspector && selected && (
            <ConnectionInspector
              profile={selected}
              metrics={inspectorMetrics}
              onClose={() => setSelectedId(null)}
              onEdit={() => openEdit(selected.id)}
              onDuplicate={() => duplicateProfile(selected.id)}
              onDelete={() => requestDelete(selected.id)}
            />
          )}
        </div>

        <StatusBar
          profileCount={profiles.length}
          visibleCount={visibleProfiles.length}
          filterActive={filterActive}
          vaultReady={runtime.summary?.credentialStorageReady ?? false}
          version={runtime.summary?.version ?? APP_VERSION}
          storage={storage}
          updater={inAppUpdaterAvailable ? updater : undefined}
          onUpdateClick={() => {
            setUpdatePromptDismissed(false);
            if (
              updater.status === "idle" ||
              updater.status === "up-to-date" ||
              updater.status === "error"
            ) {
              void updater.checkForUpdates();
            }
          }}
        />
      </main>

      <Suspense fallback={<LazyOverlayFallback />}>
      {drawer.open && (
        <ConnectionDrawer
          key={drawer.profileId ?? "new"}
          profile={editing}
          profiles={profiles}
          supportedProtocols={supportedProtocols}
          mobile={onMobile}
          onSave={saveDraft}
          onClose={() => setDrawer({ open: false, profileId: null })}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title={
            deleteGuard.mode === "saved"
              ? t("confirm.delete.credential.title", { name: deleting.name })
              : deleteGuard.mode === "unavailable" || profileDeleteError
                ? t("confirm.delete.credential.unavailable.title")
                : t("confirm.delete.title", { name: deleting.name })
          }
          body={
            deleteGuard.mode === "saved"
              ? t("confirm.delete.credential.body", {
                  provider: deleteGuard.provider,
                })
              : deleteGuard.mode === "unavailable" || profileDeleteError
                ? t("confirm.delete.credential.unavailable.body", {
                    detail:
                      profileDeleteError ??
                      (deleteGuard.mode === "unavailable"
                        ? deleteGuard.detail
                        : ""),
                  })
                : deleteGuard.mode === "loading"
                  ? t("confirm.delete.credential.loading")
                  : t("confirm.delete.body", { host: deleting.hostname })
          }
          confirmLabel={
            deleteGuard.mode === "saved"
              ? t("confirm.delete.credential.openVault")
              : deleteGuard.mode === "loading"
                ? t("confirm.delete.credential.checking")
                : deleteGuard.mode === "unavailable" || profileDeleteError
                  ? t("confirm.delete.credential.blocked")
                  : t("confirm.delete.confirm", { name: deleting.name })
          }
          confirmDisabled={
            deleteGuard.mode === "loading" ||
            deleteGuard.mode === "unavailable" ||
            profileDeleteError !== null
          }
          tone={deleteGuard.mode === "saved" ? "default" : "danger"}
          cancelLabel={t("common.cancel")}
          busy={removingProfile}
          onConfirm={() => {
            if (removingProfile) return;
            if (deleteGuard.mode === "saved") {
              setView("vault");
              setProfileDeleteError(null);
              setPendingDelete(null);
              return;
            }
            setRemovingProfile(true);
            void removeProfile(deleting.id)
              .then(() => setPendingDelete(null))
              .catch((reason: unknown) => {
                setProfileDeleteError(
                  reason instanceof Error ? reason.message : String(reason),
                );
              })
              .finally(() => setRemovingProfile(false));
          }}
          onCancel={() => {
            if (removingProfile) return;
            setProfileDeleteError(null);
            setPendingDelete(null);
          }}
        />
      )}

      {connectTarget && runtime.host === "browser" && (
        <DesktopBackendRequiredDialog onClose={() => setConnectTarget(null)} />
      )}

      {remoteHostOpen && runtime.host === "browser" && (
        <DesktopBackendRequiredDialog onClose={() => setRemoteHostOpen(false)} />
      )}
      {remoteHostOpen && runtime.host === "tauri" && (
        <RemoteHostDialog
          host={remoteHost}
          sensitiveClipboardClear={preferences.sensitiveClipboardClear}
          onClose={() => setRemoteHostOpen(false)}
        />
      )}

      {quickConnectOpen && runtime.host === "browser" && (
        <DesktopBackendRequiredDialog onClose={() => setQuickConnectOpen(false)} />
      )}
      {quickConnectOpen && runtime.host === "tauri" && (
        <RemoteQuickConnect
          remote={remote}
          onConnected={(result) => {
            setQuickConnectOpen(false);
            // Keep the device in My connections so the next session can use
            // its saved address and optionally remember the pairing code in
            // the secure credential backend.
            const memory = rememberRelayDevice(workspace.profiles, result);
            if (memory?.action === "add") workspace.addProfile(memory.draft);
            else if (memory) workspace.updateProfile(memory.id, memory.draft);
            setActiveSessionId(result.sessionId);
            setView("terminal");
          }}
          onCancel={() => setQuickConnectOpen(false)}
        />
      )}

      {runtime.host === "tauri" && connectTarget?.protocol === "ssh" && (
        <ConnectFlow
          profile={connectTarget}
          ssh={ssh}
          onConnected={(sessionId) => {
            setConnectTarget(null);
            setActiveSessionId(sessionId);
            setView("terminal");
          }}
          onCancel={() => setConnectTarget(null)}
        />
      )}

      {runtime.host === "tauri" && connectTarget?.protocol === "lattice" && (
        <RemoteConnectFlow
          profile={connectTarget}
          remote={remote}
          onRelayAddressChanged={(relayAddress) => {
            // The device moved to a new relay. Keep the saved entry pointing
            // at the address that just worked, and let the remembered
            // install-wide address follow it, since a quick tunnel rename
            // invalidates that one too.
            workspace.updateProfile(connectTarget.id, {
              ...draftFromProfile(connectTarget),
              relayAddress,
            });
            saveRelayAddress(window.localStorage, relayAddress);
          }}
          onConnected={(sessionId) => {
            setConnectTarget(null);
            setActiveSessionId(sessionId);
            setView("terminal");
          }}
          onCancel={() => setConnectTarget(null)}
        />
      )}

      {runtime.host === "tauri" && connectTarget?.protocol === "sftp" && (
        <SftpConnectFlow
          profile={connectTarget}
          sftp={sftp}
          onConnected={(sessionId) => {
            setConnectTarget(null);
            setActiveSessionId(sessionId);
            setView("terminal");
          }}
          onCancel={() => setConnectTarget(null)}
        />
      )}

      {runtime.host === "tauri" &&
        connectTarget &&
        onMobile &&
        (connectTarget.protocol === "rdp" || connectTarget.protocol === "vnc") && (
        <div className="scrim scrim--center" role="presentation" onMouseDown={() => setConnectTarget(null)}>
          <div
            ref={mobileDesktopDialogRef}
            className="dialog"
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="dialog__head">
              <h2 className="dialog__title">{t("mobile.desktopOnly.title")}</h2>
            </header>
            <div className="dialog__stack">
              <p className="dialog__body">{t("mobile.desktopOnly.body")}</p>
              <div className="dialog__actions">
                <button
                  ref={mobileDesktopCloseRef}
                  type="button"
                  className="button button--primary"
                  onClick={() => setConnectTarget(null)}
                >
                  {t("common.close")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {runtime.host === "tauri" &&
        !onMobile &&
        connectTarget?.protocol === "rdp" && (
        <RdpConnectFlow
          profile={connectTarget}
          rdp={rdp}
          onConnected={(sessionId) => {
            setConnectTarget(null);
            setActiveSessionId(sessionId);
            setView("terminal");
          }}
          onCancel={() => setConnectTarget(null)}
        />
      )}

      {runtime.host === "tauri" &&
        !onMobile &&
        connectTarget?.protocol === "vnc" && (
        <VncConnectFlow
          profile={connectTarget}
          vnc={vnc}
          onConnected={(sessionId) => {
            setConnectTarget(null);
            setActiveSessionId(sessionId);
            setView("terminal");
          }}
          onCancel={() => setConnectTarget(null)}
        />
      )}

      {paletteOpen && (
        <CommandPalette
          commands={commands}
          profiles={profiles}
          onSelectProfile={(profile) => {
            setView("connections");
            setSelectedId(profile.id);
          }}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {showUpdatePrompt && (
        <UpdatePrompt
          updater={updater}
          onDismiss={() => setUpdatePromptDismissed(true)}
        />
      )}
      </Suspense>
    </div>
  );
}

/**
 * Preferences are read once, here, and handed down: the language has to be
 * settled before anything below renders, and a second copy of the state would
 * quietly diverge from this one.
 */
export default function App() {
  const preferences = usePreferences();

  return (
    <I18nProvider locale={preferences.preferences.locale}>
      <Workspace {...preferences} />
    </I18nProvider>
  );
}
