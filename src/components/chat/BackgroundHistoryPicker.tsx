import { ArchiveFileIcon } from "../icons";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../i18n/context";
import {
  useNativeHistory,
  nativeConversationKey,
} from "../../app/useNativeConversations";
import type { ContextReport } from "../../app/memoryCompaction";
import { COMPACTED } from "../../app/memoryCompaction";
import { useModalFocus } from "../overlays/modalFocus";
import { ContextDetails } from "./CompactionNotice";
function Picker({
  onClose,
  onAttach,
}: {
  onClose: () => void;
  onAttach: (report: ContextReport) => void;
}) {
  const { t } = useI18n();
  const history = useNativeHistory();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string[]>([]),
    [query, setQuery] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(false),
    [preview, setPreview] = useState<ContextReport | null>(null);
  useModalFocus({
    dialogRef,
    onEscape: () => {
      if (!busy) onClose();
    },
  });
  const entries = (history?.entries ?? []).filter(
    (entry) =>
      !query ||
      `${entry.title} ${entry.definitionId} ${entry.workingDirectory}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );
  async function prepare() {
    if (!history || !selected.length || selected.length > 5) return;
    setBusy(true);
    setError(false);
    try {
      const entries = history.entries.filter((entry) =>
        selected.includes(nativeConversationKey(entry)),
      );
      if (entries.length !== selected.length)
        throw new Error("Selected history changed");
      const result = await invoke<ContextReport>("memory_background_context", {
        selections: entries.map((entry) => ({
          definitionId: entry.definitionId,
          nativeSessionId: entry.nativeSessionId,
          profileId: entry.profileId,
        })),
        profiles: JSON.parse(history.profileKey),
      });
      setPreview(result);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return createPortal(
    <div
      className="scrim scrim--center"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        ref={dialogRef}
        className="memory-dialog"
        aria-label={t("memory.attachHistory")}
      >
        <h2>{t("memory.attachHistory")}</h2>
        <p>{t("memory.backgroundHint")}</p>
        {error && <p role="alert">{t("memory.backgroundFailed")}</p>}
        {!preview ? (
          <>
            <input
              className="input"
              aria-label={t("memory.searchHistory")}
              value={query}
              disabled={busy}
              onChange={(event) => setQuery(event.target.value)}
            />
            <p>{selected.length} / 5</p>
            <div className="memory-background-list">
              {entries.map((entry) => {
                const key = nativeConversationKey(entry);
                return (
                  <label className="chat-card" key={key}>
                    <input
                      type="checkbox"
                      checked={selected.includes(key)}
                      disabled={
                        busy ||
                        (selected.length >= 5 && !selected.includes(key))
                      }
                      onChange={(event) =>
                        setSelected((old) =>
                          event.target.checked
                            ? [...old, key]
                            : old.filter((id) => id !== key),
                        )
                      }
                    />
                    <span>
                      {entry.title || t("chat.untitled")}
                      <small>
                        {entry.definitionId} · {entry.workingDirectory}
                      </small>
                    </span>
                  </label>
                );
              })}
            </div>
            {history?.hasMore && (
              <button
                type="button"
                className="button"
                disabled={history.busy || busy}
                onClick={history.loadMore}
              >
                {t("history.loadOlder")}
              </button>
            )}
            {history?.incomplete && <p>{t("history.stale")}</p>}
            <button
              type="button"
              className="button button--primary"
              disabled={busy || !selected.length}
              onClick={() => void prepare()}
            >
              {t("memory.previewBackground")}
            </button>
          </>
        ) : (
          <>
            <ContextDetails report={preview} />
            <button
              type="button"
              className="button button--primary"
              onClick={() => {
                if (preview.compacted)
                  window.dispatchEvent(
                    new CustomEvent(COMPACTED, { detail: preview }),
                  );
                onAttach(preview);
                onClose();
              }}
            >
              {t("memory.createWithBackground")}
            </button>
            <button
              type="button"
              className="button"
              onClick={() => setPreview(null)}
            >
              {t("memory.reselect")}
            </button>
          </>
        )}
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={onClose}
        >
          {t("common.cancel")}
        </button>
      </div>
    </div>,
    document.body,
  );
}
export function BackgroundHistoryPicker({
  onAttach,
  disabled = false,
}: {
  onAttach: (report: ContextReport) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="session-composer__icon"
        aria-label={t("memory.attachHistory")}
        title={t("memory.attachHistory")}
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <ArchiveFileIcon size={16} />
      </button>
      {open && <Picker onClose={() => setOpen(false)} onAttach={onAttach} />}
    </>
  );
}
