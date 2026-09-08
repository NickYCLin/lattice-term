import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  RemoteApi,
  RemoteDirectory,
  RemoteFileEntry,
  RemoteSessionSummary,
} from "../../app/useRemoteSessions";
import { displayPath } from "../../app/displayPath";
import { formatBytes } from "../../domain/metrics";
import { useI18n } from "../../i18n/context";
import { Callout } from "../common/Callout";
import { FileEntryIcon } from "../files/FileEntryIcon";
import { useRemoteTextEditor } from "../files/RemoteTextEditorProvider";
import { useAppDialogs } from "../overlays/useAppDialogs";
import {
  CloseIcon,
  CodeFileIcon,
  ExportIcon,
  FolderIcon,
  ImportIcon,
  RefreshIcon,
} from "../icons";

function parentPath(path: string): string {
  if (path === "/") return "/";
  const normalized = path.replace(/\/+$/, "");
  const boundary = normalized.lastIndexOf("/");
  return boundary <= 0 ? "/" : normalized.slice(0, boundary);
}

export function RemoteFilesPane({
  session,
  remote,
}: {
  session: RemoteSessionSummary;
  remote: RemoteApi;
}) {
  const { t, tag } = useI18n();
  const editor = useRemoteTextEditor();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [directory, setDirectory] = useState<RemoteDirectory | null>(null);
  const [pathInput, setPathInput] = useState("/");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const sessionTransfers = Object.values(remote.transfers)
    .filter((transfer) => transfer.sessionId === session.sessionId)
    .sort((left, right) => left.transferId.localeCompare(right.transferId));

  async function open(path: string) {
    setLoading(true);
    setProblem(null);
    try {
      const next = await remote.listFiles(session.sessionId, path);
      setDirectory(next);
      setPathInput(next.path);
    } catch (reason) {
      setProblem(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void open("/");
  }, [session.sessionId]);

  function submitPath(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void open(pathInput);
  }

  async function download(entry: RemoteFileEntry) {
    setProblem(null);
    try {
      await remote.downloadFile(session.sessionId, entry.path);
    } catch (reason) {
      setProblem(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function edit(entry: RemoteFileEntry) {
    editor.open({
      path: entry.path,
      read: () => remote.readTextFile(session.sessionId, entry.path),
      save: (content, revision) => remote.saveTextFile(session.sessionId, entry.path, content, revision),
      onClosed: () => { if (mounted.current && directory) void open(directory.path); },
    });
  }

  const { confirm, dialogs } = useAppDialogs();

  async function upload(file: File | undefined) {
    if (!file || !directory) return;
    const existing = directory.entries.find((entry) => entry.name === file.name);
    if (existing?.kind === "directory" || existing?.kind === "symlink") {
      setProblem(t("remote.files.cannotOverwrite", { name: file.name }));
      if (uploadRef.current) uploadRef.current.value = "";
      return;
    }
    if (
      existing &&
      !(await confirm({
        title: t("remote.files.dialog.overwriteTitle", { name: file.name }),
        body: t("remote.files.overwriteConfirm", { name: file.name }),
        confirmLabel: t("remote.files.dialog.overwrite"),
        cancelLabel: t("common.cancel"),
      }))
    ) {
      if (uploadRef.current) uploadRef.current.value = "";
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await remote.uploadFile(
        session.sessionId,
        directory.path,
        file,
        Boolean(existing),
      );
      await open(directory.path);
    } catch (reason) {
      setProblem(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
      if (uploadRef.current) uploadRef.current.value = "";
    }
  }

  function modified(entry: RemoteFileEntry): string {
    if (entry.modifiedAt === null) return "—";
    return new Intl.DateTimeFormat(tag, {
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(entry.modifiedAt * 1000));
  }

  return (
    <div className="remote-files-pane">
      <header className="remote-files-toolbar">
        <form className="remote-files-path" onSubmit={submitPath}>
          <FolderIcon size={14} />
          <input
            className="input mono"
            value={pathInput}
            disabled={loading || busy}
            aria-label={t("remote.files.path")}
            onChange={(event) => setPathInput(event.currentTarget.value)}
          />
        </form>
        <div className="remote-files-actions">
          <button
            type="button"
            className="button button--ghost button--sm"
            disabled={loading || busy || !directory || directory.path === "/"}
            onClick={() => directory && void open(parentPath(directory.path))}
          >
            {t("remote.files.up")}
          </button>
          <button
            type="button"
            className="icon-button icon-button--sm"
            disabled={loading || busy || !directory}
            onClick={() => directory && void open(directory.path)}
            aria-label={t("remote.files.refresh")}
            data-tooltip={t("remote.files.refresh")}
          >
            <RefreshIcon size={13} />
          </button>
          <button
            type="button"
            className="button button--primary button--sm"
            disabled={loading || busy || !directory}
            onClick={() => uploadRef.current?.click()}
          >
            <ImportIcon size={13} />
            {t("remote.files.upload")}
          </button>
          <input
            ref={uploadRef}
            type="file"
            hidden
            aria-label={t("remote.files.upload")}
            onChange={(event) => void upload(event.currentTarget.files?.[0])}
          />
        </div>
      </header>

      <div className="remote-files-root mono">
        {t("remote.files.sharedRoot", {
          name: displayPath(session.fileRootLabel),
        })}
      </div>
      {!session.fileEdit && (
        <div className="remote-files-root">{t("fileEditor.unsupportedHost")}</div>
      )}

      {problem && (
        <div className="remote-files-problem">
          <Callout tone="warn" title={t("remote.files.problem")}>
            {problem}
          </Callout>
        </div>
      )}

      <div className="remote-files-list">
        {loading ? (
          <div className="remote-files-state">{t("remote.files.loading")}</div>
        ) : directory?.entries.length === 0 ? (
          <div className="remote-files-state">{t("remote.files.empty")}</div>
        ) : (
          <table className="remote-files-table">
            <thead>
              <tr>
                <th>{t("remote.files.name")}</th>
                <th>{t("remote.files.size")}</th>
                <th>{t("remote.files.modified")}</th>
                <th aria-label={t("remote.files.actions")} />
              </tr>
            </thead>
            <tbody>
              {directory?.entries.map((entry) => {
                const downloadable = entry.kind === "file";
                return (
                  <tr key={entry.path}>
                    <td>
                      <button
                        type="button"
                        className="remote-files-entry"
                        disabled={busy || (!downloadable && entry.kind !== "directory")}
                        onClick={() =>
                          entry.kind === "directory"
                            ? void open(entry.path)
                            : downloadable
                              ? void download(entry)
                              : undefined
                        }
                      >
                        <FileEntryIcon
                          name={entry.name}
                          kind={entry.kind}
                          size={14}
                        />
                        <span>{entry.name}</span>
                      </button>
                    </td>
                    <td className="mono">
                      {entry.kind === "file" ? formatBytes(entry.size) : "—"}
                    </td>
                    <td>{modified(entry)}</td>
                    <td>
                      {downloadable && session.fileEdit && (
                        <button
                          type="button"
                          className="icon-button icon-button--sm"
                          disabled={busy || editor.active}
                          onClick={() => edit(entry)}
                          aria-label={t("fileEditor.edit")}
                          data-tooltip={t("fileEditor.edit")}
                        >
                          <CodeFileIcon size={12} />
                        </button>
                      )}
                      {downloadable && (
                        <button
                          type="button"
                          className="icon-button icon-button--sm"
                          disabled={busy}
                          onClick={() => void download(entry)}
                          aria-label={t("remote.files.download")}
                          data-tooltip={t("remote.files.download")}
                        >
                          <ExportIcon size={12} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {sessionTransfers.length > 0 && (
        <div className="remote-files-transfers">
          {sessionTransfers.map((transfer) => {
            const percent =
              transfer.totalBytes !== null && transfer.totalBytes > 0
                ? Math.min(
                    100,
                    Math.round((transfer.bytesDone / transfer.totalBytes) * 100),
                  )
                : transfer.state === "done"
                  ? 100
                  : 0;
            return (
              <div className="remote-files-transfer" key={transfer.transferId}>
                {transfer.kind === "download" ? (
                  <ExportIcon size={12} />
                ) : (
                  <ImportIcon size={12} />
                )}
                <span className="mono truncate">{transfer.name}</span>
                <span className="remote-files-progress" aria-hidden="true">
                  <span
                    className={`state-${transfer.state}`}
                    style={{ width: `${percent}%` }}
                  />
                </span>
                <span className="remote-files-transfer__detail">
                  {transfer.state === "running"
                    ? `${formatBytes(transfer.bytesDone)}${
                        transfer.totalBytes !== null
                          ? ` / ${formatBytes(transfer.totalBytes)}`
                          : ""
                      }`
                    : transfer.detail ?? t(`remote.files.transfer.${transfer.state}`)}
                </span>
                <button
                  type="button"
                  className="icon-button icon-button--sm"
                  onClick={() =>
                    void (transfer.state === "running"
                      ? remote.cancelFileTransfer(
                          session.sessionId,
                          transfer.transferId,
                        )
                      : remote.dismissFileTransfer(
                          session.sessionId,
                          transfer.transferId,
                        ))
                  }
                  aria-label={
                    transfer.state === "running"
                      ? t("remote.files.transfer.cancel")
                      : t("remote.files.transfer.clear")
                  }
                >
                  <CloseIcon size={11} />
                </button>
              </div>
            );
          })}
        </div>
      )}
      {dialogs}
    </div>
  );
}
