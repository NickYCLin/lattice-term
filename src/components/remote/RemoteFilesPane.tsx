import { useFileDrop } from "../../app/fileDrop";
import { droppedUpload, localFileError, type UploadFile } from "../../app/localFiles";
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
import { FileNameFilter, filterFileNames } from "../files/FileNameFilter";
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
  const listingGeneration = useRef(0);
  const sessionScope = useRef({ sessionId: session.sessionId });
  if (sessionScope.current.sessionId !== session.sessionId) {
    sessionScope.current = { sessionId: session.sessionId };
  }
  const scope = sessionScope.current;
  const current = () => mounted.current && sessionScope.current === scope;
  const uploading = useRef<object | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; listingGeneration.current += 1; };
  }, []);
  const [directory, setDirectory] = useState<RemoteDirectory | null>(null);
  const [fileQuery, setFileQuery] = useState("");
  const visibleEntries = filterFileNames(directory?.entries ?? [], fileQuery);
  const [pathInput, setPathInput] = useState("/");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const sessionTransfers = Object.values(remote.transfers)
    .filter((transfer) => transfer.sessionId === session.sessionId)
    .sort((left, right) => left.transferId.localeCompare(right.transferId));

  async function open(path: string) {
    if (!current()) return;
    const generation = ++listingGeneration.current;
    if (path !== directory?.path) setFileQuery("");
    setLoading(true);
    setProblem(null);
    setDirectory(null);
    setPathInput(path);
    try {
      const next = await remote.listFiles(session.sessionId, path);
      if (!current() || generation !== listingGeneration.current) return;
      setDirectory(next);
      setPathInput(next.path);
    } catch (reason) {
      if (current() && generation === listingGeneration.current) {
        setProblem(localFileError(reason, t));
      }
    } finally {
      if (current() && generation === listingGeneration.current) setLoading(false);
    }
  }

  useEffect(() => {
    uploading.current = null;
    setFileQuery("");
    setBusy(false);
    void open("/");
    return () => { listingGeneration.current += 1; };
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
      if (current()) setProblem(localFileError(reason, t));
    }
  }

  function edit(entry: RemoteFileEntry) {
    editor.open({
      path: entry.path,
      read: () => remote.readTextFile(session.sessionId, entry.path),
      save: (content, revision) => remote.saveTextFile(session.sessionId, entry.path, content, revision),
      onClosed: () => { if (current() && directory) void open(directory.path); },
    });
  }

  const { confirm, dialogs } = useAppDialogs();

  async function upload(file: UploadFile | undefined) {
    if (!current() || !file || !directory) return;
    const existing = directory.entries.find((entry) => entry.name === file.name);
    if (existing?.kind === "directory" || existing?.kind === "symlink") {
      setProblem(t("remote.files.cannotOverwrite", { name: file.name }));
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
      return;
    }
    if (!current()) return;
    await remote.uploadFile(
      session.sessionId,
      directory.path,
      file,
      Boolean(existing),
    );
    if (current()) await open(directory.path);
  }

  async function uploadBatch(sources: Array<UploadFile | string>) {
    if (!current() || uploading.current || loading || editor.active || !directory) return;
    const batch = {};
    uploading.current = batch;
    setBusy(true);
    setProblem(null);
    try {
      for (const source of sources) {
        if (!current()) return;
        const file = typeof source === "string" ? await droppedUpload(source) : source;
        if (!current()) return;
        await upload(file);
      }
    } catch (reason) {
      if (current()) setProblem(localFileError(reason, t));
    } finally {
      if (uploading.current === batch) uploading.current = null;
      if (current()) {
        setBusy(false);
        if (uploadRef.current) uploadRef.current.value = "";
      }
    }
  }

  const dropRef = useRef<HTMLDivElement>(null);
  const { dragging, ...dropHandlers } = useFileDrop({
    ref: dropRef, disabled: busy || loading || editor.active || !directory,
    onPaths: uploadBatch,
    onFiles: uploadBatch,
    onError: error => setProblem(localFileError(error, t)),
  });

  function modified(entry: RemoteFileEntry): string {
    if (entry.modifiedAt === null) return "—";
    return new Intl.DateTimeFormat(tag, {
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(entry.modifiedAt * 1000));
  }

  return (
    <div ref={dropRef} {...dropHandlers} className={`remote-files-pane${dragging ? " is-file-dropping" : ""}`}>
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
            disabled={loading || busy || (directory?.path ?? pathInput) === "/"}
            onClick={() => void open(parentPath(directory?.path ?? pathInput))}
          >
            {t("remote.files.up")}
          </button>
          <button
            type="button"
            className="icon-button icon-button--sm"
            disabled={loading || busy}
            onClick={() => void open(directory?.path ?? pathInput)}
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
            multiple
            hidden
            disabled={loading || busy || !directory}
            aria-label={t("remote.files.upload")}
            onChange={(event) => { void uploadBatch(Array.from(event.currentTarget.files ?? [])); }}
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

      <FileNameFilter value={fileQuery} onChange={setFileQuery} disabled={loading || !directory} />
      <div className="remote-files-list">
        {loading ? (
          <div className="remote-files-state">{t("remote.files.loading")}</div>
        ) : directory?.entries.length === 0 ? (
          <div className="remote-files-state">{t("remote.files.empty")}</div>
        ) : directory && visibleEntries.length === 0 ? (
          <div className="remote-files-state" role="status">{t("files.filter.noResults")}</div>
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
              {visibleEntries.map((entry) => {
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
                      {entry.kind === "file" ? formatBytes(entry.size, tag) : "—"}
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
                    ? `${formatBytes(transfer.bytesDone, tag)}${
                        transfer.totalBytes !== null
                          ? ` / ${formatBytes(transfer.totalBytes, tag)}`
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
