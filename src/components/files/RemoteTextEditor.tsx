import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isTauri } from "@tauri-apps/api/core";
import {
  prepareRemoteText,
  remoteTextByteLength,
  RemoteTextError,
  REMOTE_TEXT_MAX_BYTES,
  serializeRemoteText,
  type RemoteTextBuffer,
  type RemoteTextDocument,
} from "../../domain/remoteText";
import { useI18n } from "../../i18n/context";
import { CloseIcon, CodeFileIcon, RefreshIcon } from "../icons";
import { ConfirmDialog } from "../overlays/ConfirmDialog";
import { useModalFocus } from "../overlays/modalFocus";
import "./RemoteTextEditor.css";

export interface RemoteTextEditorProps {
  path: string;
  read: () => Promise<RemoteTextDocument>;
  save: (content: string, revision: string, acknowledgeAccessChange?: boolean) => Promise<RemoteTextDocument>;
  onClose: () => void;
}

/** The caller keeps this mounted until onClose, including during tab switches. */
export function RemoteTextEditor(props: RemoteTextEditorProps) {
  return <RemoteTextEditorSession key={props.path} {...props} />;
}

function RemoteTextEditorSession({ path, read, save, onClose }: RemoteTextEditorProps) {
  const { t, tag } = useI18n();
  const titleId = useId();
  const hintId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const callbacks = useRef({ read, save });
  callbacks.current = { read, save };
  const operation = useRef<"loading" | "saving" | null>(null);
  const generation = useRef(0);
  const [busy, setBusy] = useState<"loading" | "saving" | null>("loading");
  const [document, setDocument] = useState<RemoteTextDocument | null>(null);
  const [buffer, setBuffer] = useState<RemoteTextBuffer | null>(null);
  const [draft, setDraft] = useState("");
  const draftRef = useRef(draft);
  const [error, setError] = useState<{ action: "read" | "save" | "input"; detail: unknown } | null>(null);
  const [confirmation, setConfirmation] = useState<"close" | "reload" | "closeWindow" | "saveAccess" | null>(null);
  const [nativeCloseReady, setNativeCloseReady] = useState(() => !isTauri());
  const [closeNotice, setCloseNotice] = useState<{ kind: "saving" | "unavailable" | "failed"; detail?: unknown } | null>(null);
  const closeNativeWindow = useRef<(() => Promise<void>) | null>(null);
  const bufferRef = useRef(buffer);
  bufferRef.current = buffer;
  const [saved, setSaved] = useState(false);
  const dirty = buffer !== null && draft !== buffer.draft;
  const prepared = useMemo(() => {
    if (!buffer) return { content: "", problem: null };
    try {
      return { content: serializeRemoteText(buffer, draft), problem: null };
    } catch (detail) {
      return { content: "", problem: detail };
    }
  }, [buffer, draft]);

  function describeError(detail: unknown): string {
    if (detail instanceof RemoteTextError) return t(`fileEditor.error.${detail.problem}`);
    return detail instanceof Error ? detail.message : String(detail);
  }

  function replaceDraft(next: string) {
    draftRef.current = next;
    setDraft(next);
  }

  async function load() {
    if (operation.current) return;
    operation.current = "loading";
    const ticket = ++generation.current;
    setBusy("loading");
    setError(null);
    setSaved(false);
    try {
      const nextDocument = await callbacks.current.read();
      const nextBuffer = prepareRemoteText(nextDocument.content);
      if (ticket !== generation.current) return;
      setDocument(nextDocument);
      bufferRef.current = nextBuffer;
      setBuffer(nextBuffer);
      replaceDraft(nextBuffer.draft);
    } catch (detail) {
      if (ticket === generation.current) setError({ action: "read", detail });
    } finally {
      if (ticket === generation.current) {
        operation.current = null;
        setBusy(null);
      }
    }
  }

  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
      operation.current = null;
    };
    // This session is keyed by path. Changing callback identities must not
    // reload a user's draft; callbacks.current always supplies fresh handlers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!dirty && busy !== "saving") return;
    function beforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty, busy]);

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let unlisten: (() => void) | null = null;
    async function protectNativeClose() {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        if (!active) return;
        const nativeWindow = getCurrentWindow();
        closeNativeWindow.current = () => nativeWindow.destroy();
        const dispose = await nativeWindow.onCloseRequested((event) => {
          // Tauri does not implement the browser beforeunload confirmation.
          // Always cancel first; only an explicit in-app confirmation may
          // destroy a dirty window. A save in flight must finish first.
          event.preventDefault();
          if (!active) return;
          if (operation.current === "saving") {
            setCloseNotice({ kind: "saving" });
            dialogRef.current?.focus();
          } else if (bufferRef.current && draftRef.current !== bufferRef.current.draft) {
            setConfirmation("closeWindow");
          } else {
            void nativeWindow.destroy().catch((detail: unknown) => {
              if (active) setCloseNotice({ kind: "failed", detail });
            });
          }
        });
        if (active) {
          unlisten = dispose;
          setNativeCloseReady(true);
        } else dispose();
      } catch (detail) {
        if (active) setCloseNotice({ kind: "unavailable", detail });
      }
    }
    void protectNativeClose();
    return () => {
      active = false;
      closeNativeWindow.current = null;
      unlisten?.();
    };
  }, []);

  async function saveDraft(acknowledgeAccessChange = false) {
    if (operation.current || !document || !buffer || !nativeCloseReady) return;
    const snapshot = draftRef.current;
    if (snapshot === buffer.draft) return;
    let content: string;
    try {
      content = serializeRemoteText(buffer, snapshot);
    } catch (detail) {
      setError({ action: "save", detail });
      return;
    }
    if (document.requiresAccessConfirmation && !acknowledgeAccessChange) {
      setConfirmation("saveAccess");
      return;
    }
    operation.current = "saving";
    const ticket = ++generation.current;
    setBusy("saving");
    setError(null);
    setCloseNotice(null);
    setSaved(false);
    try {
      const nextDocument = await callbacks.current.save(
        content,
        document.revision,
        document.requiresAccessConfirmation === true && acknowledgeAccessChange,
      );
      const nextBuffer = prepareRemoteText(nextDocument.content);
      if (ticket !== generation.current) return;
      setDocument(nextDocument);
      bufferRef.current = nextBuffer;
      setBuffer(nextBuffer);
      // Typing may continue while the server saves. Never replace input made
      // after this request; only advance the saved baseline and revision.
      if (draftRef.current === snapshot) replaceDraft(nextBuffer.draft);
      setSaved(true);
    } catch (detail) {
      if (ticket === generation.current) setError({ action: "save", detail });
    } finally {
      if (ticket === generation.current) {
        operation.current = null;
        setBusy(null);
        setCloseNotice((notice) => notice?.kind === "saving" ? null : notice);
      }
    }
  }

  function requestClose() {
    if (operation.current === "saving") return;
    if (bufferRef.current && draftRef.current !== bufferRef.current.draft) setConfirmation("close");
    else onClose();
  }

  function requestReload() {
    if (operation.current) return;
    if (bufferRef.current && draftRef.current !== bufferRef.current.draft) setConfirmation("reload");
    else void load();
  }

  useModalFocus({
    dialogRef,
    getInitialFocus: () => textareaRef.current,
    onEscape: requestClose,
    escapeDisabled: busy === "saving",
  });

  const pathParts = path.split(/[\\/]/).filter(Boolean);
  const name = pathParts[pathParts.length - 1] ?? path;
  const byteLength = prepared.problem ? remoteTextByteLength(draft) : remoteTextByteLength(prepared.content);
  const status = busy === "saving" ? t("fileEditor.saving")
    : busy === "loading" ? t("fileEditor.loading")
      : !buffer ? t("fileEditor.notLoaded") : dirty ? t("fileEditor.unsaved")
        : saved ? t("fileEditor.saved") : t("fileEditor.unchanged");

  const editor = (
    <div className="remote-text-editor-layer">
      <div className="scrim scrim--center" role="presentation" onMouseDown={requestClose}>
        <div
          ref={dialogRef}
          className="remote-text-editor"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={hintId}
          aria-busy={busy !== null || undefined}
          tabIndex={-1}
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.stopPropagation();
              if (!confirmation) void saveDraft();
            }
          }}
        >
          <header className="remote-text-editor__header">
            <span className="remote-text-editor__icon"><CodeFileIcon size={22} /></span>
            <div className="remote-text-editor__heading">
              <h2 id={titleId} title={name}>{t("fileEditor.title")} <span>{name}</span></h2>
              <p className="remote-text-editor__path" title={path}>{path}</p>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label={t("common.close")}
              title={t("common.close")}
              disabled={busy === "saving"}
              onClick={requestClose}
            ><CloseIcon size={18} /></button>
          </header>
          <p id={hintId} className="remote-text-editor__hint">{t("fileEditor.hint")}</p>
          <p className="remote-text-editor__hint">{t("fileEditor.backupNotice")}</p>
          {closeNotice && <div className="remote-text-editor__notice" role="alert">
            <span>{t(`fileEditor.windowClose.${closeNotice.kind}`)}</span>
            {closeNotice.detail !== undefined && <span>{describeError(closeNotice.detail)}</span>}
          </div>}
          {error && (
            <div className="remote-text-editor__notice remote-text-editor__notice--error" role="alert">
              <strong>{t(error.action === "read" ? "fileEditor.readFailed" : error.action === "input" ? "fileEditor.inputRejected" : "fileEditor.saveFailed")}</strong>
              <span>{describeError(error.detail)}</span>
              {error.action === "save" && <span>{t("fileEditor.draftRetained")}</span>}
              {error.action === "read" && <button type="button" className="button button--ghost" disabled={busy !== null} onClick={requestReload}>{t("fileEditor.retry")}</button>}
            </div>
          )}
          {document && (document.warning || document.backupPath) && (
            <div className="remote-text-editor__notice" role="status">
              {document.warning && <span>{document.warning}</span>}
              {document.backupPath && <span>{t("fileEditor.backup", { path: document.backupPath })}</span>}
            </div>
          )}
          {buffer ? (
            <textarea
              ref={textareaRef}
              className="remote-text-editor__input"
              aria-label={t("fileEditor.content")}
              value={draft}
              readOnly={busy === "loading" || !nativeCloseReady}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              wrap="off"
              maxLength={REMOTE_TEXT_MAX_BYTES}
              onPaste={(event) => {
                const field = event.currentTarget;
                const paste = event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
                const nextDraft = draftRef.current.slice(0, field.selectionStart) + paste + draftRef.current.slice(field.selectionEnd);
                try {
                  serializeRemoteText(buffer, nextDraft);
                } catch (detail) {
                  // Native maxlength silently truncates a large paste. Reject
                  // the entire paste visibly, keeping the prior draft intact.
                  event.preventDefault();
                  setError({ action: "input", detail });
                }
              }}
              onChange={(event) => {
                replaceDraft(event.currentTarget.value);
                setSaved(false);
              }}
            />
          ) : (
            <div className="remote-text-editor__empty" role="status">{busy === "loading" ? t("fileEditor.loading") : t("fileEditor.notLoaded")}</div>
          )}
          {prepared.problem !== null && <p className="remote-text-editor__validation" role="alert">{describeError(prepared.problem)}</p>}
          <footer className="remote-text-editor__footer">
            <div className="remote-text-editor__metadata">
              <span className={dirty ? "remote-text-editor__status remote-text-editor__status--dirty" : "remote-text-editor__status"} role="status">{status}</span>
              {buffer && <span>{buffer.bom ? "UTF-8 BOM" : "UTF-8"} · {buffer.lineEnding.toUpperCase()} · {new Intl.NumberFormat(tag).format(byteLength)} B / 1 MiB</span>}
            </div>
            <div className="remote-text-editor__actions">
              <button type="button" className="button button--ghost" disabled={busy !== null} onClick={requestReload}><RefreshIcon />{t("fileEditor.reload")}</button>
              <button type="button" className="button button--primary" disabled={busy !== null || !dirty || prepared.problem !== null || !nativeCloseReady} onClick={() => void saveDraft()} title={t("fileEditor.saveShortcut")}>{busy === "saving" ? t("fileEditor.saving") : t("common.save")}<kbd aria-hidden="true">⌘/Ctrl S</kbd></button>
            </div>
          </footer>
        </div>
      </div>
      {confirmation && (
        <ConfirmDialog
          title={t(confirmation === "saveAccess" ? "fileEditor.accessTitle" : confirmation === "closeWindow" ? "fileEditor.discardWindowTitle" : "fileEditor.discardTitle")}
          body={t(confirmation === "saveAccess" ? "fileEditor.accessBody" : confirmation === "closeWindow" ? "fileEditor.discardWindowBody" : confirmation === "close" ? "fileEditor.discardCloseBody" : "fileEditor.discardReloadBody")}
          confirmLabel={t(confirmation === "saveAccess" ? "fileEditor.accessConfirm" : confirmation === "closeWindow" ? "fileEditor.discardWindow" : confirmation === "close" ? "fileEditor.discardClose" : "fileEditor.discardReload")}
          cancelLabel={t(confirmation === "saveAccess" ? "common.cancel" : "fileEditor.keepEditing")}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            const action = confirmation;
            setConfirmation(null);
            if (action === "saveAccess") {
              void saveDraft(true);
            } else if (action === "closeWindow") {
              void closeNativeWindow.current?.().catch((detail: unknown) => setCloseNotice({ kind: "failed", detail }));
            } else if (action === "close") onClose();
            else void load();
          }}
        />
      )}
    </div>
  );
  return typeof window === "undefined" || !window.document?.body
    ? editor : createPortal(editor, window.document.body);
}
