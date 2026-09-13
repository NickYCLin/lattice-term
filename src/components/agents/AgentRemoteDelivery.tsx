import { FileDropZone } from "../files/FileDropZone";
import type { UploadFile } from "../../app/localFiles";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  RemoteApi,
  RemoteDirectory,
  RemoteFileTransfer,
  RemoteSessionSummary,
} from "../../app/useRemoteSessions";
import { displayPath } from "../../app/displayPath";
import { formatBytes } from "../../domain/metrics";
import { useI18n } from "../../i18n/context";
import { Callout } from "../common/Callout";
import { CloseIcon, FolderIcon, ImportIcon, TransferIcon } from "../icons";
import { ConfirmDialog } from "../overlays/ConfirmDialog";

type DeliveryRemoteApi = Pick<
  RemoteApi,
  "sessions" | "transfers" | "listFiles" | "uploadFile" | "cancelFileTransfer"
>;

interface PendingDelivery {
  file: UploadFile;
  session: RemoteSessionSummary;
  parent: string;
  overwrite: boolean;
}

interface ActiveDelivery {
  sessionId: string;
  destination: string;
  initialTransfer: RemoteFileTransfer;
}

export function remoteFileSessions(
  sessions: RemoteSessionSummary[],
): RemoteSessionSummary[] {
  return sessions.filter((session) => session.fileTransfer);
}

export function inspectRemoteDeliveryTarget(
  directory: RemoteDirectory,
  fileName: string,
): { overwrite: boolean; blocked: boolean } {
  const existing = directory.entries.find((entry) => entry.name === fileName);
  return {
    overwrite: Boolean(existing),
    blocked: existing?.kind === "directory" || existing?.kind === "symlink",
  };
}

export function remoteDeliveryPath(parent: string, fileName: string): string {
  return `${parent === "/" ? "" : parent.replace(/\/+$/, "")}/${fileName}`;
}

export function remoteDeliveryPercent(transfer: RemoteFileTransfer): number {
  if (transfer.totalBytes === null || transfer.totalBytes <= 0) {
    return transfer.state === "done" ? 100 : 0;
  }
  return Math.max(
    0,
    Math.min(100, Math.round((transfer.bytesDone / transfer.totalBytes) * 100)),
  );
}

export function cancelRemoteDelivery(
  remote: Pick<RemoteApi, "cancelFileTransfer">,
  sessionId: string,
  transferId: string,
): Promise<void> {
  return remote.cancelFileTransfer(sessionId, transferId);
}

export function AgentRemoteDelivery({ remote }: { remote: DeliveryRemoteApi }) {
  const { t, tag } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sessions = useMemo(
    () => remoteFileSessions(remote.sessions),
    [remote.sessions],
  );
  const [sessionId, setSessionId] = useState(
    () => sessions[0]?.sessionId ?? "",
  );
  const [parent, setParent] = useState("/");
  const [file, setFile] = useState<UploadFile | null>(null);
  const [pending, setPending] = useState<PendingDelivery | null>(null);
  const [phase, setPhase] = useState<"checking" | "sending" | null>(null);
  const [active, setActive] = useState<ActiveDelivery | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const cancelRequestedRef = useRef(false);
  const [delivered, setDelivered] = useState<{
    name: string;
    destination: string;
  } | null>(null);
  const busy = phase !== null;
  const activeTransfer = active
    ? remote.transfers[active.initialTransfer.transferId] ?? active.initialTransfer
    : null;
  const activePercent = activeTransfer
    ? remoteDeliveryPercent(activeTransfer)
    : 0;

  useEffect(() => {
    if (sessions.some((session) => session.sessionId === sessionId)) return;
    setSessionId(sessions[0]?.sessionId ?? "");
  }, [sessionId, sessions]);

  async function review() {
    const session = sessions.find((candidate) => candidate.sessionId === sessionId);
    if (!session || !file) return;
    setPhase("checking");
    setProblem(null);
    setDelivered(null);
    try {
      const directory = await remote.listFiles(
        session.sessionId,
        parent.trim() || "/",
      );
      const target = inspectRemoteDeliveryTarget(directory, file.name);
      if (target.blocked) {
        setProblem(t("remote.files.cannotOverwrite", { name: file.name }));
        return;
      }
      setParent(directory.path);
      setPending({
        file,
        session,
        parent: directory.path,
        overwrite: target.overwrite,
      });
    } catch (reason) {
      setProblem(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPhase(null);
    }
  }

  async function deliver() {
    const request = pending;
    if (!request) return;
    setPending(null);
    setPhase("sending");
    setActive(null);
    setCancelling(false);
    cancelRequestedRef.current = false;
    setProblem(null);
    try {
      await remote.uploadFile(
        request.session.sessionId,
        request.parent,
        request.file,
        request.overwrite,
        (transfer) =>
          setActive({
            sessionId: request.session.sessionId,
            destination: remoteDeliveryPath(request.parent, request.file.name),
            initialTransfer: transfer,
          }),
      );
      setProblem(null);
      setDelivered({
        name: request.file.name,
        destination: remoteDeliveryPath(request.parent, request.file.name),
      });
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (reason) {
      if (!cancelRequestedRef.current) {
        setProblem(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      cancelRequestedRef.current = false;
      setCancelling(false);
      setActive(null);
      setPhase(null);
    }
  }

  async function cancelDelivery() {
    if (!active || !activeTransfer || activeTransfer.state !== "running") return;
    cancelRequestedRef.current = true;
    setCancelling(true);
    setProblem(null);
    try {
      await cancelRemoteDelivery(
        remote,
        active.sessionId,
        active.initialTransfer.transferId,
      );
    } catch (reason) {
      cancelRequestedRef.current = false;
      setCancelling(false);
      setProblem(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <section className="agents-delivery">
      <div className="agents-section-heading">
        <div>
          <span className="eyebrow">{t("agents.delivery.eyebrow")}</span>
          <h3>{t("agents.delivery.title")}</h3>
          <p>{t("agents.delivery.body")}</p>
        </div>
      </div>

      <Callout tone="security" title={t("agents.delivery.securityTitle")}>
        {t("agents.delivery.securityBody")}
      </Callout>

      {sessions.length === 0 ? (
        <p className="agents-running__empty">
          {t("agents.delivery.noSession")}
        </p>
      ) : (
        <div className="agents-delivery__form">
          <label className="field">
            <span className="field__label">{t("agents.delivery.target")}</span>
            <select
              className="input"
              value={sessionId}
              disabled={busy}
              onChange={(event) => {
                setSessionId(event.currentTarget.value);
                setProblem(null);
                setDelivered(null);
              }}
            >
              {sessions.map((session) => (
                <option key={session.sessionId} value={session.sessionId}>
                  {t("agents.delivery.targetOption", {
                    host: session.host,
                    name: session.agentName,
                    root: displayPath(session.fileRootLabel),
                  })}
                </option>
              ))}
            </select>
            <span className="agents-field-hint">
              {t("agents.delivery.targetHint")}
            </span>
          </label>

          <label className="field">
            <span className="field__label">
              <FolderIcon size={13} />
              {t("agents.delivery.folder")}
            </span>
            <input
              className="input mono"
              value={parent}
              disabled={busy}
              onChange={(event) => {
                setParent(event.currentTarget.value);
                setProblem(null);
                setDelivered(null);
              }}
              spellCheck={false}
            />
            <span className="agents-field-hint">
              {t("agents.delivery.folderHint")}
            </span>
          </label>

          <div className="field agents-delivery__file">
            <span className="field__label">{t("agents.delivery.file")}</span>
            <input
              ref={fileInputRef}
              type="file"
              hidden
              aria-label={t("agents.delivery.choose")}
              onChange={(event) => {
                setFile(event.currentTarget.files?.[0] ?? null);
                setProblem(null);
                setDelivered(null);
              }}
            />
            <FileDropZone disabled={busy || pending !== null} onSelect={file => { setFile(file); setProblem(null); setDelivered(null); }}>
            <div className="agents-delivery__file-row">
              <button
                type="button"
                className="button button--secondary"
                disabled={busy}
                onClick={() => fileInputRef.current?.click()}
              >
                <ImportIcon size={13} />
                {t("agents.delivery.choose")}
              </button>
              <span className="agents-delivery__selection">
                {file
                  ? t("agents.delivery.selected", {
                      name: file.name,
                      size: formatBytes(file.size, tag),
                    })
                  : t("agents.delivery.noFile")}
              </span>
            </div>
            </FileDropZone>
          </div>

          <button
            type="button"
            className="button button--primary agents-delivery__submit"
            disabled={busy || !sessionId || !file}
            onClick={() => void review()}
          >
            <TransferIcon size={13} />
            {phase === "checking"
              ? t("agents.delivery.checking")
              : phase === "sending"
                ? t("agents.delivery.sending")
                : t("agents.delivery.review")}
          </button>
        </div>
      )}

      {problem && (
        <Callout tone="danger" title={t("agents.delivery.failedTitle")}>
          <span className="mono">{problem}</span>
        </Callout>
      )}

      {active && activeTransfer && (
        <div className="agents-delivery__progress" aria-live="polite">
          <div className="agents-delivery__progress-heading">
            <div>
              <strong>{activeTransfer.name}</strong>
              <span className="mono">{active.destination}</span>
            </div>
            <button
              type="button"
              className="button button--secondary"
              disabled={cancelling || activeTransfer.state !== "running"}
              onClick={() => void cancelDelivery()}
            >
              <CloseIcon size={12} />
              {cancelling
                ? t("agents.delivery.cancelling")
                : t("agents.delivery.cancel")}
            </button>
          </div>
          <div
            className="agents-delivery__progress-track"
            role="progressbar"
            aria-label={t("agents.delivery.progressLabel", {
              name: activeTransfer.name,
            })}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={activePercent}
          >
            <span style={{ width: `${activePercent}%` }} />
          </div>
          <span className="agents-delivery__progress-detail">
            {activeTransfer.totalBytes === null
              ? t("agents.delivery.progressUnknown", {
                  done: formatBytes(activeTransfer.bytesDone, tag),
                })
              : t("agents.delivery.progress", {
                  done: formatBytes(activeTransfer.bytesDone, tag),
                  total: formatBytes(activeTransfer.totalBytes, tag),
                  percent: activePercent,
                })}
          </span>
        </div>
      )}

      {delivered && (
        <Callout tone="info" title={t("agents.delivery.successTitle")}>
          {t("agents.delivery.successBody", delivered)}
        </Callout>
      )}

      {pending && (
        <ConfirmDialog
          title={t("agents.delivery.confirmTitle", {
            name: pending.file.name,
          })}
          body={t(
            pending.overwrite
              ? "agents.delivery.confirmOverwriteBody"
              : "agents.delivery.confirmBody",
            {
              destination: remoteDeliveryPath(
                pending.parent,
                pending.file.name,
              ),
              name: pending.session.agentName,
              root: displayPath(pending.session.fileRootLabel),
            },
          )}
          confirmLabel={t("agents.delivery.confirmAction")}
          cancelLabel={t("common.cancel")}
          tone="default"
          onConfirm={() => void deliver()}
          onCancel={() => setPending(null)}
        />
      )}
    </section>
  );
}
