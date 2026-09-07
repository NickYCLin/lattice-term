/**
 * SSH Tunnels & Port Forwarding View.
 *
 * Provides a comprehensive, interactive workspace to manage, start, stop,
 * and monitor Local (-L), Remote (-R), and Dynamic SOCKS5 (-D) port forwarding
 * over pure Rust SSH connections.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { copyTextToClipboard } from "../app/clipboardText";
import {
  formatBytes,
  formatSshTunnelCommand,
  type TunnelConfig,
  type TunnelDraft,
  type TunnelType,
  type TunnelValidationError,
} from "../domain/tunnel";
import { useTunnels } from "../app/useTunnels";
import type { ConnectionProfile } from "../domain/connection";
import { useI18n } from "../i18n/context";
import { Chip } from "../components/common/Badge";
import { Callout } from "../components/common/Callout";
import { useModalFocus } from "../components/overlays/modalFocus";
import {
  CheckIcon,
  CloseIcon,
  CopyIcon,
  DuplicateIcon,
  EditIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  StopIcon,
  TrashIcon,
  TunnelIcon,
} from "../components/icons";

interface TunnelsViewProps {
  profiles: ConnectionProfile[];
  backendAvailable: boolean;
  onActivity?: (type: string, detail: string) => void;
}

export function TunnelsView({
  profiles,
  backendAvailable,
  onActivity,
}: TunnelsViewProps) {
  const { t } = useI18n();
  const sshProfiles = useMemo(() => profiles.filter((profile) => profile.protocol === "ssh"), [profiles]);
  const {
    tunnels,
    states,
    addTunnel,
    updateTunnel,
    deleteTunnel,
    duplicateTunnel,
    startTunnel,
    stopTunnel,
    startAll,
    stopAll,
  } = useTunnels(profiles, onActivity, backendAvailable);

  // Backend failures arrive as "code:detail"; the code picks the translated
  // explanation and the detail fills in the specifics where useful.
  const tunnelErrorText = (raw: string): string => {
    const split = raw.indexOf(":");
    const code = split > 0 ? raw.slice(0, split) : "";
    const detail = split > 0 ? raw.slice(split + 1).trim() : raw;
    switch (code) {
      case "credential":
        return t("tunnels.error.credentialMissing");
      case "trust":
        return t("tunnels.error.trustRequired");
      case "auth":
        return t("tunnels.error.authFailed");
      case "profile":
        return t("tunnels.error.profileMissing");
      case "runtime":
        return t("tunnels.error.desktopOnly");
      case "stop":
        return t("tunnels.error.stopFailed", { detail });
      case "delete":
        return t("tunnels.error.deleteFailed", { detail });
      default:
        return t("tunnels.error.startFailed", { detail });
    }
  };

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | TunnelType>("all");
  const [editingTunnel, setEditingTunnel] = useState<TunnelConfig | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deletingTunnel, setDeletingTunnel] = useState(false);
  const [deleteProblem, setDeleteProblem] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyProblem, setCopyProblem] = useState<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const copyRequestRef = useRef(0);

  useEffect(
    () => () => {
      copyRequestRef.current += 1;
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    },
    [],
  );

  // Filtered tunnels
  const filteredTunnels = useMemo(() => {
    return tunnels.filter((t) => {
      if (typeFilter !== "all" && t.type !== typeFilter) {
        return false;
      }
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      const profile = sshProfiles.find((p) => p.id === t.profileId);
      return (
        t.name.toLowerCase().includes(q) ||
        String(t.localPort).includes(q) ||
        t.remoteHost.toLowerCase().includes(q) ||
        String(t.remotePort).includes(q) ||
        (profile?.name.toLowerCase().includes(q) ?? false) ||
        (profile?.hostname.toLowerCase().includes(q) ?? false)
      );
    });
  }, [tunnels, search, typeFilter, sshProfiles]);

  // Summary Metrics
  const totalCount = tunnels.length;
  const activeCount = Object.values(states).filter((s) => s.status === "active").length;
  const totalUploaded = Object.values(states).reduce((acc, s) => acc + s.bytesUploaded, 0);
  const totalDownloaded = Object.values(states).reduce((acc, s) => acc + s.bytesDownloaded, 0);

  const handleCopyCommand = async (tunnel: TunnelConfig) => {
    const profile = sshProfiles.find((p) => p.id === tunnel.profileId);
    // Without a matching profile the command keeps its obvious placeholders
    // instead of silently borrowing some other connection's gateway.
    const cmd = profile
      ? formatSshTunnelCommand(tunnel, profile.username, profile.hostname, profile.port)
      : formatSshTunnelCommand(tunnel);

    const request = ++copyRequestRef.current;
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
    setCopiedId(null);
    setCopyProblem(null);
    try {
      await copyTextToClipboard(cmd);
      if (request !== copyRequestRef.current) return;
      setCopiedId(tunnel.id);
      copyTimerRef.current = window.setTimeout(() => {
        if (request === copyRequestRef.current) {
          setCopiedId(null);
          copyTimerRef.current = null;
        }
      }, 2_000);
    } catch (reason) {
      if (request !== copyRequestRef.current) return;
      setCopyProblem(
        t("common.copyFailed.body", {
          error: reason instanceof Error ? reason.message : String(reason),
        }),
      );
    }
  };

  async function confirmDelete() {
    const id = pendingDeleteId;
    if (!id || deletingTunnel) return;

    setDeletingTunnel(true);
    setDeleteProblem(null);
    try {
      const outcome = await deleteTunnel(id);
      if (outcome.success) {
        setPendingDeleteId(null);
      } else {
        setDeleteProblem(
          tunnelErrorText(outcome.error ?? "delete:unknown error"),
        );
      }
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      setDeleteProblem(tunnelErrorText("delete:" + detail));
    } finally {
      setDeletingTunnel(false);
    }
  }

  function cancelDelete() {
    if (deletingTunnel) return;
    setPendingDeleteId(null);
    setDeleteProblem(null);
  }

  return (
    <div className="stack tunnels" style={{ gap: "var(--space-6)" }}>
      {/* 1. Summary Metrics Bar */}
      <div className="metrics-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "var(--space-4)" }}>
        <div className="panel glass glass--sheen" style={{ padding: "var(--space-4)", borderRadius: "var(--radius-lg)" }}>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)", marginBottom: "var(--space-1)" }}>
            {t("tunnels.metrics.total")}
          </div>
          <div style={{ fontSize: "var(--text-2xl)", fontWeight: 700, color: "var(--text)" }}>
            {totalCount}
          </div>
        </div>

        <div className="panel glass glass--sheen" style={{ padding: "var(--space-4)", borderRadius: "var(--radius-lg)" }}>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)", marginBottom: "var(--space-1)", display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: activeCount > 0 ? "var(--ok)" : "var(--text-faint)", display: "inline-block" }} />
            {t("tunnels.metrics.active")}
          </div>
          <div style={{ fontSize: "var(--text-2xl)", fontWeight: 700, color: activeCount > 0 ? "var(--ok)" : "var(--text)" }}>
            {activeCount}
          </div>
        </div>

        <div className="panel glass glass--sheen" style={{ padding: "var(--space-4)", borderRadius: "var(--radius-lg)" }}>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)", marginBottom: "var(--space-1)" }}>
            {t("tunnels.metrics.traffic")}
          </div>
          <div style={{ fontSize: "var(--text-2xl)", fontWeight: 700, color: "var(--accent)" }}>
            {formatBytes(totalUploaded + totalDownloaded)}
          </div>
        </div>
      </div>

      {!backendAvailable && (
        <Callout tone="info" title={t("tunnels.desktopOnly.title")}>
          {t("tunnels.desktopOnly.body")}
        </Callout>
      )}
      {copyProblem && (
        <Callout tone="danger" title={t("common.copyFailed.title")}>
          {copyProblem}
        </Callout>
      )}

      {/* 2. Control Toolbar */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "var(--space-4)" }}>
        <div className="tunnels__filters" style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flex: "1 1 300px" }}>
          <div style={{ position: "relative", width: "100%", maxWidth: "340px" }}>
            <span style={{ position: "absolute", left: "var(--space-3)", top: "50%", transform: "translateY(-50%)", color: "var(--text-faint)" }}>
              <SearchIcon size={16} />
            </span>
            <input
              type="search"
              className="input"
              style={{ width: "100%", paddingLeft: "var(--space-8)" }}
              placeholder={t("tunnels.searchPlaceholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className="segmented-control" style={{ display: "flex", background: "var(--surface-solid)", padding: "2px", borderRadius: "var(--radius-md)" }}>
            {(["all", "local", "dynamic", "remote"] as const).map((type) => (
              <button
                key={type}
                type="button"
                className={`button ${typeFilter === type ? "button--secondary" : "button--ghost"}`}
                style={{ padding: "0.25rem 0.75rem", fontSize: "var(--text-xs)", height: "auto" }}
                onClick={() => setTypeFilter(type)}
              >
                {t(`tunnels.type.${type}`)}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          {activeCount > 0 ? (
            <button
              type="button"
              className="button button--ghost"
              disabled={!backendAvailable}
              onClick={() => void stopAll()}
            >
              <StopIcon size={14} />
              {t("tunnels.stopAll")}
            </button>
          ) : (
            <button
              type="button"
              className="button button--ghost"
              disabled={!backendAvailable || sshProfiles.length === 0}
              onClick={() => void startAll()}
            >
              <PlayIcon size={14} />
              {t("tunnels.startAll")}
            </button>
          )}

          <button
            type="button"
            className="button button--primary"
            disabled={sshProfiles.length === 0}
            onClick={() => setIsCreating(true)}
          >
            <PlusIcon size={15} />
            {t("tunnels.add")}
          </button>
        </div>
      </div>

      {sshProfiles.length === 0 && (
        <p style={{ margin: 0, color: "var(--warn)", fontSize: "var(--text-sm)" }}>
          {t("tunnels.sshRequired")}
        </p>
      )}

      {/* 3. Tunnels List */}
      {filteredTunnels.length === 0 ? (
        <div className="panel glass glass--sheen" style={{ padding: "var(--space-9)", textAlign: "center" }}>
          <div style={{ color: "var(--text-faint)", marginBottom: "var(--space-3)" }}>
            <TunnelIcon size={48} />
          </div>
          <h3 style={{ margin: "0 0 var(--space-2)", fontSize: "var(--text-lg)", color: "var(--text)" }}>
            {search ? t("tunnels.emptySearch") : t("tunnels.empty")}
          </h3>
          <p style={{ margin: "0 0 var(--space-5)", color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>
            {t("tunnels.emptyHint")}
          </p>
          {!search && (
            <button
              type="button"
              className="button button--primary"
              disabled={sshProfiles.length === 0}
              onClick={() => setIsCreating(true)}
            >
              <PlusIcon size={15} />
              {t("tunnels.add")}
            </button>
          )}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: "var(--space-4)" }}>
          {filteredTunnels.map((tunnel) => {
            const state = states[tunnel.id] || { status: "stopped", bytesUploaded: 0, bytesDownloaded: 0, activeConnections: 0 };
            const isActive = state.status === "active";
            const isStarting = state.status === "starting";
            const profile = sshProfiles.find((p) => p.id === tunnel.profileId);
            const isCopied = copiedId === tunnel.id;

            return (
              <div
                key={tunnel.id}
                className="panel glass glass--sheen"
                style={{
                  padding: "var(--space-5)",
                  borderRadius: "var(--radius-lg)",
                  border: isActive ? "1px solid var(--accent-line)" : "1px solid var(--line)",
                  transition: "all var(--duration-fast) var(--ease)",
                }}
              >
                {/* Header Row */}
                <div className="tunnels__card-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--space-4)" }}>
                  <div className="tunnels__card-title" style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                    <h3 style={{ margin: 0, fontSize: "var(--text-md)", fontWeight: 600, color: "var(--text)" }}>
                      {tunnel.name}
                    </h3>
                    <Chip tone={tunnel.type === "local" ? "info" : tunnel.type === "dynamic" ? "planned" : "warn"}>
                      {t(`tunnels.type.${tunnel.type}`)}
                    </Chip>
                    {isActive && (
                      <Chip tone="ok">
                        <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "var(--ok)", marginRight: 4 }} />
                        {t("tunnels.status.active")}
                      </Chip>
                    )}
                    {isStarting && <Chip tone="warn">{t("tunnels.status.starting")}</Chip>}
                    {state.status === "stopped" && <Chip tone="neutral">{t("tunnels.status.stopped")}</Chip>}
                    {state.status === "error" && <Chip tone="danger">{t("tunnels.status.error")}</Chip>}
                  </div>

                  {/* Toggle Run Button */}
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                    <button
                      type="button"
                      className={`button ${isActive ? "button--secondary" : "button--primary"}`}
                      style={{ padding: "0.35rem 0.85rem", height: "auto" }}
                      disabled={
                        isStarting ||
                        !backendAvailable ||
                        (!isActive && !profile)
                      }
                      onClick={() => {
                        if (isActive) {
                          void stopTunnel(tunnel.id);
                        } else {
                          void startTunnel(tunnel.id);
                        }
                      }}
                    >
                      {isActive ? (
                        <>
                          <StopIcon size={14} />
                          {t("tunnels.action.stop")}
                        </>
                      ) : (
                        <>
                          <PlayIcon size={14} />
                          {t("tunnels.action.start")}
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {/* Visual Routing Flow */}
                <div
                  style={{
                    background: "var(--surface-solid)",
                    padding: "var(--space-4)",
                    borderRadius: "var(--radius-md)",
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    gap: "var(--space-4)",
                    fontSize: "var(--text-sm)",
                    marginBottom: "var(--space-4)",
                  }}
                >
                  {/* Source */}
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    <span style={{ fontSize: "var(--text-2xs)", color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "var(--tracking-caps)" }}>
                      {tunnel.type === "remote"
                        ? t("tunnels.flow.remoteBind")
                        : t("tunnels.flow.localBind")}
                    </span>
                    <span className="mono" style={{ fontWeight: 600, color: "var(--text)" }}>
                      {tunnel.localHost}:{tunnel.localPort}
                    </span>
                  </div>

                  <span style={{ color: "var(--text-faint)", fontSize: "1.25rem" }}>➔</span>

                  {/* SSH Jump Gateway */}
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    <span style={{ fontSize: "var(--text-2xs)", color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "var(--tracking-caps)" }}>
                      {t("tunnels.flow.jumpGateway")}
                    </span>
                    <span style={{ fontWeight: 600, color: "var(--accent)" }}>
                      {profile?.name || profile?.hostname || t("tunnels.flow.unassigned")}
                    </span>
                    <small className="mono" style={{ color: "var(--text-muted)", fontSize: "var(--text-2xs)" }}>
                      {profile ? `${profile.username}@${profile.hostname}:${profile.port}` : "—"}
                    </small>
                  </div>

                  <span style={{ color: "var(--text-faint)", fontSize: "1.25rem" }}>➔</span>

                  {/* Remote Target / SOCKS5 */}
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    <span style={{ fontSize: "var(--text-2xs)", color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "var(--tracking-caps)" }}>
                      {tunnel.type === "dynamic"
                        ? t("tunnels.flow.dynamicProxy")
                        : tunnel.type === "remote"
                          ? t("tunnels.flow.localTarget")
                          : t("tunnels.flow.remoteTarget")}
                    </span>
                    <span className="mono" style={{ fontWeight: 600, color: "var(--text)" }}>
                      {tunnel.type === "dynamic" ? "SOCKS5 Proxy (Any Host)" : `${tunnel.remoteHost}:${tunnel.remotePort}`}
                    </span>
                  </div>
                </div>

                {/* Why the last start failed, in the user's language. */}
                {state.lastError && (
                  <p style={{ margin: "0 0 var(--space-4)", fontSize: "var(--text-sm)", color: "var(--danger)" }}>
                    {tunnelErrorText(state.lastError)}
                  </p>
                )}

                {/* Description & Metrics Footnote */}
                {tunnel.description && (
                  <p style={{ margin: "0 0 var(--space-4)", fontSize: "var(--text-sm)", color: "var(--text-muted)" }}>
                    {tunnel.description}
                  </p>
                )}

                {/* Action Bar & Stats */}
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)", borderTop: "1px solid var(--line)", paddingTop: "var(--space-3)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4)", fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
                    <span>
                      {t("tunnels.stats.transferred")}: <strong style={{ color: "var(--text)" }}>{formatBytes(state.bytesUploaded + state.bytesDownloaded)}</strong>
                    </span>
                    {isActive && (
                      <span>
                        {t("tunnels.stats.connections")}: <strong style={{ color: "var(--ok)" }}>{state.activeConnections}</strong>
                      </span>
                    )}
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                    <button
                      type="button"
                      className="button button--ghost"
                      style={{ padding: "0.25rem 0.6rem", fontSize: "var(--text-xs)" }}
                      onClick={() => void handleCopyCommand(tunnel)}
                      title={t("tunnels.action.copySsh")}
                    >
                      {isCopied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
                      {isCopied ? t("common.copied") : t("tunnels.action.copySsh")}
                    </button>

                    <button
                      type="button"
                      className="button button--ghost"
                      style={{ padding: "0.25rem 0.6rem", fontSize: "var(--text-xs)" }}
                      onClick={() => setEditingTunnel(tunnel)}
                      title={t("tunnels.action.edit")}
                    >
                      <EditIcon size={14} />
                      {t("tunnels.action.edit")}
                    </button>

                    <button
                      type="button"
                      className="button button--ghost"
                      style={{ padding: "0.25rem 0.6rem", fontSize: "var(--text-xs)" }}
                      onClick={() => duplicateTunnel(tunnel.id)}
                      title={t("tunnels.action.duplicate")}
                    >
                      <DuplicateIcon size={14} />
                      {t("tunnels.action.duplicate")}
                    </button>

                    <button
                      type="button"
                      className="button button--ghost"
                      style={{ padding: "0.25rem 0.6rem", fontSize: "var(--text-xs)", color: "var(--danger)" }}
                      onClick={() => {
                        setDeleteProblem(null);
                        setPendingDeleteId(tunnel.id);
                      }}
                      title={t("tunnels.action.delete")}
                    >
                      <TrashIcon size={14} />
                      {t("tunnels.action.delete")}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 4. Create / Edit Tunnel Modal Drawer */}
      {(isCreating || editingTunnel) && (
        <TunnelFormModal
          initial={editingTunnel}
          profiles={sshProfiles}
          onClose={() => {
            setIsCreating(false);
            setEditingTunnel(null);
          }}
          onSave={(draft) => {
            if (editingTunnel) {
              const res = updateTunnel(editingTunnel.id, draft);
              if (res.success) {
                setEditingTunnel(null);
              }
              return res;
            } else {
              const res = addTunnel(draft);
              if (res.success) {
                setIsCreating(false);
              }
              return res;
            }
          }}
        />
      )}

      {/* 5. Delete Confirmation Modal */}
      {pendingDeleteId && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.7)",
            display: "grid",
            placeItems: "center",
            zIndex: 100,
            backdropFilter: "blur(4px)",
          }}
        >
          <div className="panel glass glass--sheen" style={{ maxWidth: 420, width: "90%", padding: "var(--space-6)", borderRadius: "var(--radius-lg)" }}>
            <h3 style={{ margin: "0 0 var(--space-2)", fontSize: "var(--text-lg)", color: "var(--text)" }}>
              {t("tunnels.deleteConfirm.title")}
            </h3>
            <p style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)", margin: "0 0 var(--space-6)" }}>
              {t("tunnels.deleteConfirm.body")}
            </p>
            {deleteProblem && (
              <p
                role="alert"
                style={{
                  color: "var(--danger)",
                  fontSize: "var(--text-sm)",
                  margin: "calc(var(--space-4) * -1) 0 var(--space-6)",
                }}
              >
                {deleteProblem}
              </p>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-3)" }}>
              <button
                type="button"
                className="button button--ghost"
                onClick={cancelDelete}
                disabled={deletingTunnel}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="button button--primary"
                style={{ background: "var(--danger)" }}
                onClick={() => void confirmDelete()}
                disabled={deletingTunnel}
              >
                {deletingTunnel
                  ? t("tunnels.deleteConfirm.deleting")
                  : t("common.delete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface TunnelFormModalProps {
  initial: TunnelConfig | null;
  profiles: ConnectionProfile[];
  onClose: () => void;
  onSave: (draft: TunnelDraft) => { success: boolean; errors?: TunnelValidationError[] };
}

function TunnelFormModal({ initial, profiles, onClose, onSave }: TunnelFormModalProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus({ dialogRef, onEscape: onClose });

  const [name, setName] = useState(initial?.name || "");
  const [type, setType] = useState<TunnelType>(initial?.type || "local");
  const [profileId, setProfileId] = useState(initial?.profileId || profiles[0]?.id || "");
  const [localHost, setLocalHost] = useState(initial?.localHost || "127.0.0.1");
  const [localPort, setLocalPort] = useState<string | number>(initial?.localPort || 8080);
  const [remoteHost, setRemoteHost] = useState(initial?.remoteHost || "localhost");
  const [remotePort, setRemotePort] = useState<string | number>(initial?.remotePort || 80);
  const [autoStart, setAutoStart] = useState(Boolean(initial?.autoStart));
  const [description, setDescription] = useState(initial?.description || "");
  const [errors, setErrors] = useState<Record<string, string>>({});

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const draft: TunnelDraft = {
      name,
      type,
      profileId,
      localHost,
      localPort,
      remoteHost,
      remotePort,
      autoStart,
      description,
    };

    const result = onSave(draft);
    if (!result.success && result.errors) {
      const errMap: Record<string, string> = {};
      for (const err of result.errors) {
        errMap[err.field] = t(err.messageKey);
      }
      setErrors(errMap);
    }
  };

  return (
    <div
      className="tunnel-form-scrim"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.7)",
        display: "grid",
        placeItems: "center",
        zIndex: 100,
        backdropFilter: "blur(6px)",
      }}
    >
      <div
        className="panel glass glass--sheen tunnel-form"
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={initial ? t("tunnels.form.editTitle") : t("tunnels.form.createTitle")}
        style={{
          maxWidth: 540,
          width: "92%",
          maxHeight: "90vh",
          overflowY: "auto",
          padding: "var(--space-6)",
          borderRadius: "var(--radius-xl)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--space-5)" }}>
          <h2 style={{ margin: 0, fontSize: "var(--text-lg)", fontWeight: 700, color: "var(--text)" }}>
            {initial ? t("tunnels.form.editTitle") : t("tunnels.form.createTitle")}
          </h2>
          <button type="button" className="button button--ghost" aria-label={t("common.close")} onClick={onClose} style={{ padding: "0.25rem" }}>
            <CloseIcon size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          {/* Type Selector */}
          <div>
            <label className="field-label" style={{ display: "block", marginBottom: "var(--space-2)" }}>
              {t("tunnels.form.type")}
            </label>
            <div className="tunnel-form__types" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "var(--space-2)" }}>
              {(["local", "dynamic", "remote"] as const).map((tType) => (
                <button
                  key={tType}
                  type="button"
                  className={`button ${type === tType ? "button--secondary" : "button--ghost"}`}
                  style={{ fontSize: "var(--text-xs)", height: "2.5rem" }}
                  onClick={() => setType(tType)}
                >
                  {t(`tunnels.type.${tType}`)}
                </button>
              ))}
            </div>
          </div>

          {/* Name */}
          <div>
            <label className="field-label" style={{ display: "block", marginBottom: "var(--space-1)" }}>
              {t("tunnels.form.name")}
            </label>
            <input
              type="text"
              className="input"
              style={{ width: "100%" }}
              placeholder={t("tunnels.form.namePlaceholder")}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setErrors((prev) => ({ ...prev, name: "" }));
              }}
            />
            {errors.name && <small style={{ color: "var(--danger)", marginTop: 4, display: "block" }}>{errors.name}</small>}
          </div>

          {/* SSH Jump Gateway */}
          <div>
            <label className="field-label" style={{ display: "block", marginBottom: "var(--space-1)" }}>
              {t("tunnels.form.gateway")}
            </label>
            <select
              className="input select"
              style={{ width: "100%" }}
              value={profileId}
              onChange={(e) => {
                setProfileId(e.target.value);
                setErrors((prev) => ({ ...prev, profileId: "" }));
              }}
            >
              {profiles.length === 0 && (
                <option value="" disabled>
                  {t("tunnels.sshRequired")}
                </option>
              )}
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.username}@{p.hostname}:{p.port})
                </option>
              ))}
            </select>
            {errors.profileId && <small style={{ color: "var(--danger)", marginTop: 4, display: "block" }}>{errors.profileId}</small>}
          </div>

          {/* Local Binding */}
          <div className="tunnel-form__address" style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)", gap: "var(--space-3)" }}>
            <div>
              <label className="field-label" style={{ display: "block", marginBottom: "var(--space-1)" }}>
                {type === "remote"
                  ? t("tunnels.form.remoteBindHost")
                  : t("tunnels.form.localHost")}
              </label>
              <input
                type="text"
                className="input mono"
                style={{ width: "100%" }}
                value={localHost}
                onChange={(e) => {
                  setLocalHost(e.target.value);
                  setErrors((prev) => ({ ...prev, localHost: "" }));
                }}
              />
              {errors.localHost && <small style={{ color: "var(--danger)", marginTop: 4, display: "block" }}>{errors.localHost}</small>}
            </div>
            <div>
              <label className="field-label" style={{ display: "block", marginBottom: "var(--space-1)" }}>
                {type === "remote"
                  ? t("tunnels.form.remoteBindPort")
                  : t("tunnels.form.localPort")}
              </label>
              <input
                type="number"
                className="input mono"
                style={{ width: "100%" }}
                value={localPort}
                onChange={(e) => {
                  setLocalPort(e.target.value);
                  setErrors((prev) => ({ ...prev, localPort: "" }));
                }}
              />
              {errors.localPort && <small style={{ color: "var(--danger)", marginTop: 4, display: "block" }}>{errors.localPort}</small>}
            </div>
          </div>

          {/* Remote Target (Hidden if Dynamic SOCKS5) */}
          {type !== "dynamic" && (
            <div className="tunnel-form__address" style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)", gap: "var(--space-3)" }}>
              <div>
                <label className="field-label" style={{ display: "block", marginBottom: "var(--space-1)" }}>
                  {type === "remote"
                    ? t("tunnels.form.localTargetHost")
                    : t("tunnels.form.remoteHost")}
                </label>
                <input
                  type="text"
                  className="input mono"
                  style={{ width: "100%" }}
                  placeholder="e.g. 10.0.0.5 or localhost"
                  value={remoteHost}
                  onChange={(e) => {
                    setRemoteHost(e.target.value);
                    setErrors((prev) => ({ ...prev, remoteHost: "" }));
                  }}
                />
                {errors.remoteHost && <small style={{ color: "var(--danger)", marginTop: 4, display: "block" }}>{errors.remoteHost}</small>}
              </div>
              <div>
                <label className="field-label" style={{ display: "block", marginBottom: "var(--space-1)" }}>
                  {type === "remote"
                    ? t("tunnels.form.localTargetPort")
                    : t("tunnels.form.remotePort")}
                </label>
                <input
                  type="number"
                  className="input mono"
                  style={{ width: "100%" }}
                  placeholder="5432"
                  value={remotePort}
                  onChange={(e) => {
                    setRemotePort(e.target.value);
                    setErrors((prev) => ({ ...prev, remotePort: "" }));
                  }}
                />
                {errors.remotePort && <small style={{ color: "var(--danger)", marginTop: 4, display: "block" }}>{errors.remotePort}</small>}
              </div>
            </div>
          )}

          <label style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-3)", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={autoStart}
              onChange={(event) => setAutoStart(event.target.checked)}
              style={{ marginTop: 3 }}
            />
            <span>
              <strong style={{ display: "block", color: "var(--text)", fontSize: "var(--text-sm)" }}>
                {t("tunnels.form.autoStart")}
              </strong>
              <small style={{ color: "var(--text-muted)" }}>{t("tunnels.form.autoStartHint")}</small>
            </span>
          </label>

          {/* Description */}
          <div>
            <label className="field-label" style={{ display: "block", marginBottom: "var(--space-1)" }}>
              {t("tunnels.form.description")}
            </label>
            <textarea
              className="input"
              style={{ width: "100%", minHeight: "60px", resize: "vertical" }}
              placeholder={t("tunnels.form.descPlaceholder")}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {/* Form Actions */}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-3)", marginTop: "var(--space-4)" }}>
            <button type="button" className="button button--ghost" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button type="submit" className="button button--primary" disabled={profiles.length === 0}>
              {initial ? t("common.save") : t("tunnels.form.submitCreate")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
