import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type {
  SftpApi,
  SftpDirectory,
  SftpEntry,
  SftpSessionSummary,
} from "../../app/useSftpSessions";
import { useI18n } from "../../i18n/context";
import { formatBytes } from "../../domain/metrics";
import { createSerialQueue } from "../../app/serialQueue";
import { Callout } from "../common/Callout";
import { FileEntryIcon } from "../files/FileEntryIcon";
import { useRemoteTextEditor } from "../files/RemoteTextEditorProvider";
import { useAppDialogs } from "../overlays/useAppDialogs";
import {
  CloseIcon,
  CodeFileIcon,
  EditIcon,
  ExportIcon,
  FolderIcon,
  ImportIcon,
  PlusIcon,
  RefreshIcon,
  TrashIcon,
} from "../icons";

function parentPath(path: string): string {
  if (path === "/") return "/";
  const normalized = path.replace(/\/+$/, "");
  const boundary = normalized.lastIndexOf("/");
  return boundary <= 0 ? "/" : normalized.slice(0, boundary);
}

/** Last path segment of an OS path, handling both `/` and `\` separators. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function SftpPane({
  session,
  sftp,
  active = false,
}: {
  session: SftpSessionSummary;
  sftp: SftpApi;
  active?: boolean;
}) {
  const { t, tag } = useI18n();
  const editor = useRemoteTextEditor();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [directory, setDirectory] = useState<SftpDirectory | null>(null);
  const [pathInput, setPathInput] = useState(session.currentPath);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const refreshedPathUploads = useRef(new Set<string>());
  // The backend runs one listing per session and refuses a second, so every
  // listing from this pane waits its turn; only the newest open() may update
  // the view, so a slow earlier folder never replaces the one asked for last.
  const listQueue = useRef(createSerialQueue());
  const latestOpen = useRef(0);
  const list = sftp.list;
  const sessionTransfers = Object.values(sftp.transfers)
    .filter((transfer) => transfer.sessionId === session.sessionId)
    .sort((a, b) => a.transferId.localeCompare(b.transferId, undefined, { numeric: true }));

  async function open(path: string) {
    const ticket = ++latestOpen.current;
    const current = () => mounted.current && ticket === latestOpen.current;
    setLoading(true);
    setProblem(null);
    try {
      const next = await listQueue.current(() => list(session.sessionId, path));
      if (!current()) return;
      setDirectory(next);
      setPathInput(next.path);
    } catch (reason) {
      if (!current()) return;
      setProblem(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (current()) setLoading(false);
    }
  }

  useEffect(() => {
    void open(session.currentPath);
  }, [list, session.currentPath, session.sessionId]);

  // A path upload returns as soon as it enters the native queue. Refresh only
  // after its completion event, otherwise the visible target does not exist
  // yet and a fast drop appears to have done nothing.
  useEffect(() => {
    if (!directory) return;
    const currentPath = directory.path;
    const arrivals = sessionTransfers.filter(
      (transfer) =>
        transfer.kind === "upload" &&
        transfer.localPath !== null &&
        transfer.state === "done" &&
        parentPath(transfer.remotePath) === currentPath &&
        !refreshedPathUploads.current.has(transfer.transferId),
    );
    if (arrivals.length === 0) return;
    for (const transfer of arrivals) {
      refreshedPathUploads.current.add(transfer.transferId);
    }
    void listQueue.current(() => list(session.sessionId, currentPath))
      .then((next) => {
        setDirectory((current) =>
          current?.path === currentPath ? next : current,
        );
      })
      .catch((reason: unknown) => {
        setProblem(reason instanceof Error ? reason.message : String(reason));
      });
  }, [directory?.path, list, session.sessionId, sessionTransfers]);

  const { confirm, prompt, dialogs } = useAppDialogs();

  function askOverwrite(name: string) {
    return confirm({
      title: t("sftp.dialog.overwriteTitle", { name }),
      body: t("sftp.overwriteConfirm", { name }),
      confirmLabel: t("sftp.dialog.overwrite"),
      cancelLabel: t("common.cancel"),
    });
  }

  async function mutate(operation: () => Promise<void>) {
    setBusy(true);
    setProblem(null);
    try {
      await operation();
      await open(directory?.path ?? session.currentPath);
    } catch (reason) {
      setProblem(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  function submitPath(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void open(pathInput);
  }

  async function createFolder() {
    const name = await prompt({
      title: t("sftp.createPrompt"),
      label: t("sftp.dialog.nameLabel"),
      confirmLabel: t("sftp.dialog.create"),
      cancelLabel: t("common.cancel"),
    });
    if (!name?.trim() || !directory) return;
    void mutate(() =>
      sftp.createDirectory(session.sessionId, directory.path, name.trim()),
    );
  }

  async function rename(entry: SftpEntry) {
    const name = await prompt({
      title: t("sftp.renamePrompt"),
      label: t("sftp.dialog.nameLabel"),
      initialValue: entry.name,
      confirmLabel: t("sftp.dialog.rename"),
      cancelLabel: t("common.cancel"),
    });
    if (!name?.trim() || name.trim() === entry.name) return;
    void mutate(() =>
      sftp.rename(session.sessionId, entry.path, name.trim()),
    );
  }

  async function remove(entry: SftpEntry) {
    const confirmed = await confirm({
      title: t("sftp.dialog.deleteTitle", { name: entry.name }),
      body: t("sftp.deleteConfirm", { name: entry.name }),
      confirmLabel: t("sftp.dialog.delete"),
      cancelLabel: t("common.cancel"),
    });
    if (!confirmed) return;
    void mutate(() =>
      sftp.remove(
        session.sessionId,
        entry.path,
        entry.kind === "directory",
      ),
    );
  }

  async function download(entry: SftpEntry) {
    setProblem(null);
    try {
      // Streamed on the Rust side straight into the download folder — no
      // size cap, and the transfer strip below reports its progress.
      await sftp.downloadToDisk(session.sessionId, entry.path);
    } catch (reason) {
      setProblem(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function edit(entry: SftpEntry) {
    editor.open({
      path: entry.path,
      read: () => sftp.readTextFile(session.sessionId, entry.path),
      save: (content, revision, acknowledgeAccessChange) => sftp.saveTextFile(session.sessionId, entry.path, content, revision, acknowledgeAccessChange),
      onClosed: () => { if (mounted.current && directory) void open(directory.path); },
    });
  }

  async function upload(file: File | undefined) {
    if (!file || !directory) return;
    const existing = directory.entries.find((entry) => entry.name === file.name);
    if (existing?.kind === "directory") {
      setProblem(t("sftp.overwriteDirectory", { name: file.name }));
      if (uploadRef.current) uploadRef.current.value = "";
      return;
    }
    if (existing && !(await askOverwrite(file.name))) {
      if (uploadRef.current) uploadRef.current.value = "";
      return;
    }
    // Chunked through the queue: no size cap, progress in the strip below.
    await mutate(() =>
      sftp.uploadStream(
        session.sessionId,
        directory.path,
        file,
        Boolean(existing),
      ),
    );
    if (uploadRef.current) uploadRef.current.value = "";
  }

  async function dropFiles(paths: string[]) {
    if (!directory || paths.length === 0) return;
    setProblem(null);
    for (const path of paths) {
      const name = baseName(path);
      const existing = directory.entries.find((entry) => entry.name === name);
      if (existing?.kind === "directory") {
        setProblem(t("sftp.overwriteDirectory", { name }));
        continue;
      }
      if (existing && !(await askOverwrite(name))) {
        continue;
      }
      try {
        await sftp.uploadPath(
          session.sessionId,
          directory.path,
          path,
          Boolean(existing),
        );
      } catch (reason) {
        setProblem(reason instanceof Error ? reason.message : String(reason));
      }
    }
  }

  // OS drag-and-drop is delivered by Tauri as file paths (the webview's own
  // drop events are suppressed), so only the active pane binds the listener.
  useEffect(() => {
    if (!active || editor.active) {
      setDragging(false);
      return;
    }
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const { getCurrentWebviewWindow } = await import(
          "@tauri-apps/api/webviewWindow"
        );
        const stop = await getCurrentWebviewWindow().onDragDropEvent((event) => {
          if (cancelled) return;
          if (event.payload.type === "enter" || event.payload.type === "over") {
            setDragging(true);
          } else if (event.payload.type === "leave") {
            setDragging(false);
          } else if (event.payload.type === "drop") {
            setDragging(false);
            void dropFiles(event.payload.paths);
          }
        });
        if (cancelled) stop();
        else unlisten = stop;
      } catch {
        // Browser preview has no native drag-drop bridge.
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
      setDragging(false);
    };
    // Re-bind when the open directory changes so drops target the current one.
  }, [active, editor.active, directory?.path, session.sessionId]);

  async function transferAction(operation: () => Promise<void>) {
    setProblem(null);
    try {
      await operation();
    } catch (reason) {
      setProblem(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function size(entry: SftpEntry): string {
    if (entry.kind === "directory") return "—";
    return new Intl.NumberFormat(tag, {
      style: "unit",
      unit: entry.size >= 1024 * 1024 ? "megabyte" : "kilobyte",
      unitDisplay: "short",
      maximumFractionDigits: 1,
    }).format(
      entry.size >= 1024 * 1024
        ? entry.size / 1024 / 1024
        : Math.max(entry.size / 1024, 0.1),
    );
  }

  function modified(entry: SftpEntry): string {
    if (entry.modifiedAt === null) return "—";
    // A compact, fixed numeric shape (2026-06-17 21:45): the localized medium
    // format wraps to three lines in a docked panel, which reads as clutter.
    const date = new Date(entry.modifiedAt * 1000);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  return (
    <section
      className={`sftp-pane${dragging ? " sftp-pane--dropping" : ""}`}
      aria-label={t("sftp.title")}
    >
      <header className="sftp-toolbar">
        <form className="sftp-path" onSubmit={submitPath}>
          <label className="sr-only" htmlFor={`sftp-path-${session.sessionId}`}>
            {t("sftp.path")}
          </label>
          <input
            id={`sftp-path-${session.sessionId}`}
            className="input mono"
            value={pathInput}
            onChange={(event) => setPathInput(event.currentTarget.value)}
            spellCheck={false}
            disabled={loading || busy}
          />
          <button
            type="submit"
            className="button button--secondary button--sm"
            disabled={loading || busy || !pathInput.trim()}
          >
            {t("sftp.go")}
          </button>
        </form>
        <div className="sftp-actions">
          <button
            type="button"
            className="button button--ghost button--sm"
            disabled={loading || busy || directory?.path === "/"}
            onClick={() => directory && void open(parentPath(directory.path))}
          >
            <FolderIcon size={13} />
            {t("sftp.up")}
          </button>
          <button
            type="button"
            className="button button--ghost button--sm"
            disabled={loading || busy || !directory}
            onClick={() => directory && void open(directory.path)}
          >
            <RefreshIcon size={13} />
            {t("sftp.refresh")}
          </button>
          <button
            type="button"
            className="button button--ghost button--sm"
            disabled={loading || busy || !directory}
            onClick={createFolder}
          >
            <PlusIcon size={13} />
            {t("sftp.newFolder")}
          </button>
          <button
            type="button"
            className="button button--primary button--sm"
            disabled={loading || busy || !directory}
            onClick={() => uploadRef.current?.click()}
            title={t("sftp.upload.hint")}
          >
            <ImportIcon size={13} />
            {t("sftp.upload")}
          </button>
          <input
            ref={uploadRef}
            type="file"
            hidden
            aria-label={t("sftp.upload")}
            onChange={(event) => void upload(event.currentTarget.files?.[0])}
          />
        </div>
      </header>

      {problem && (
        <div className="sftp-problem">
          <Callout tone="warn" title={t("sftp.problem")}>
            {problem}
          </Callout>
        </div>
      )}

      <div className="sftp-table-wrap">
        {loading ? (
          <div className="sftp-state">{t("sftp.loading")}</div>
        ) : directory && directory.entries.length === 0 ? (
          <div className="sftp-state">{t("sftp.empty")}</div>
        ) : (
          <table className="sftp-table">
            <thead>
              <tr>
                <th>{t("sftp.column.name")}</th>
                <th>{t("sftp.column.size")}</th>
                <th>{t("sftp.column.modified")}</th>
                <th>{t("sftp.column.permissions")}</th>
                <th className="sftp-table__actions">{t("sftp.column.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {directory?.entries.map((entry) => (
                <tr key={entry.path}>
                  <td>
                    <button
                      type="button"
                      className="sftp-entry"
                      disabled={busy}
                      onClick={() =>
                        entry.kind === "directory"
                          ? void open(entry.path)
                          : void download(entry)
                      }
                    >
                      <FileEntryIcon
                        name={entry.name}
                        kind={entry.kind}
                        size={15}
                      />
                      <span>{entry.name}</span>
                    </button>
                  </td>
                  <td className="mono">{size(entry)}</td>
                  <td>{modified(entry)}</td>
                  <td className="mono">{entry.permissions}</td>
                  <td>
                    <div className="sftp-row-actions">
                      {entry.kind === "file" && (
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
                      {entry.kind !== "directory" && (
                        <button
                          type="button"
                          className="icon-button icon-button--sm"
                          disabled={busy}
                          onClick={() => void download(entry)}
                          aria-label={t("sftp.download")}
                          data-tooltip={t("sftp.download")}
                        >
                          <ExportIcon size={12} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="icon-button icon-button--sm"
                        disabled={busy}
                        onClick={() => void rename(entry)}
                        aria-label={t("sftp.rename")}
                        data-tooltip={t("sftp.rename")}
                      >
                        <EditIcon size={12} />
                      </button>
                      <button
                        type="button"
                        className="icon-button icon-button--sm"
                        disabled={busy}
                        onClick={() => void remove(entry)}
                        aria-label={t("sftp.delete")}
                        data-tooltip={t("sftp.delete")}
                      >
                        <TrashIcon size={12} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {sessionTransfers.length > 0 && (
        <div className="sftp-transfers" style={{ borderTop: "1px solid var(--line)", padding: "var(--space-3) var(--space-4)", display: "grid", gap: "var(--space-2)" }}>
          {sessionTransfers.map((transfer) => {
            const percent =
              transfer.totalBytes && transfer.totalBytes > 0
                ? Math.min(
                    100,
                    Math.round((transfer.bytesDone / transfer.totalBytes) * 100),
                  )
                : null;
            return (
              <div
                key={transfer.transferId}
                style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", fontSize: "var(--text-xs)" }}
              >
                <span aria-hidden="true" style={{ display: "flex", color: "var(--text-faint)" }}>
                  {transfer.kind === "download" ? <ExportIcon size={12} /> : <ImportIcon size={12} />}
                </span>
                <span className="mono truncate" style={{ flex: "0 1 auto", minWidth: 0 }}>
                  {transfer.name}
                </span>
                <span style={{ flex: "1 1 8rem", height: 4, borderRadius: 2, background: "var(--surface-solid)", overflow: "hidden" }}>
                  <span
                    style={{
                      display: "block",
                      height: "100%",
                      width: `${percent ?? (transfer.state === "running" ? 30 : 100)}%`,
                      background:
                        transfer.state === "error"
                          ? "var(--danger)"
                          : transfer.state === "cancelled"
                            ? "var(--text-faint)"
                            : transfer.state === "done"
                              ? "var(--ok)"
                              : "var(--accent)",
                      transition: "width var(--duration-fast) var(--ease)",
                    }}
                  />
                </span>
                <span style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                  {transfer.state === "running"
                    ? `${formatBytes(transfer.bytesDone)}${transfer.totalBytes ? ` / ${formatBytes(transfer.totalBytes)}` : ""}`
                    : transfer.state === "error"
                      ? (transfer.detail ?? t("sftp.transfer.error"))
                      : (transfer.detail ??
                        t(
                          transfer.state === "done"
                            ? "sftp.transfer.done"
                            : "sftp.transfer.cancelled",
                        ))}
                </span>
                {transfer.state === "running" ? (
                  <button
                    type="button"
                    className="icon-button icon-button--sm"
                    onClick={() =>
                      void transferAction(() =>
                        sftp.cancelTransfer(transfer.transferId),
                      )
                    }
                    aria-label={t("sftp.transfer.cancel")}
                    data-tooltip={t("sftp.transfer.cancel")}
                  >
                    <CloseIcon size={11} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="icon-button icon-button--sm"
                    onClick={() =>
                      void transferAction(() =>
                        sftp.dismissTransfer(transfer.transferId),
                      )
                    }
                    aria-label={t("sftp.transfer.dismiss")}
                    data-tooltip={t("sftp.transfer.dismiss")}
                  >
                    <TrashIcon size={11} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {dialogs}
      {dragging && directory && (
        <div className="sftp-dropzone" aria-hidden="true">
          <div className="sftp-dropzone__card">
            <ImportIcon size={22} />
            <strong>{t("sftp.drop.title")}</strong>
            <span className="mono">{directory.path}</span>
          </div>
        </div>
      )}
    </section>
  );
}
