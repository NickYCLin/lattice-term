import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n/context";
import {
  inspectMemory,
  memoryDraft,
  memoryBytes,
  mutateMemory,
  type MemorySnapshot,
} from "../../app/projectMemory";
import { maskNativeText } from "../../app/nativeRecords";
import { useModalFocus } from "../overlays/modalFocus";
import { MemoryEditor, memoryError } from "./ProjectMemoryPanel";
function SaveDialog({
  text,
  directory,
  cli,
  conversationId,
  onClose,
}: {
  text: string;
  directory: string;
  cli: string | null;
  conversationId: string | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(() =>
    memoryDraft(directory, maskNativeText(text), {
      kind: "conversation",
      cli,
      conversationId,
      path: null,
    }),
  );
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false), [pendingSync,setPendingSync]=useState(true);
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus({
    dialogRef,
    onEscape: () => {
      if (!busy) onClose();
    },
  });
  useEffect(() => {
    let disposed = false;
    void inspectMemory(directory)
      .then((value) => {
        if (!disposed) setSnapshot(value);
      })
      .catch((reason) => {
        if (!disposed) setError(String(reason));
      });
    return () => {
      disposed = true;
    };
  }, [directory]);
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
        aria-label={t("memory.saveMessage")}
        tabIndex={-1}
        ref={dialogRef}
        className="memory-dialog"
      >
        <h2>{t("memory.saveMessage")}</h2>
        <p>{t("memory.saveHint")}</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!snapshot || busy || saved) return;
            setBusy(true);
            setError("");
            void mutateMemory(directory, snapshot.revision, {
              kind: "upsert",
              draft,
            })
              .then((next) => {
                if (next.warnings.length) {
                  setPendingSync(next.warnings.some(warning=>warning!=="memory.aiFailed"&&warning!=="memory.aiUnavailable"));
                  setSaved(true);
                  setError(next.warnings[0]);
                  setBusy(false);
                } else onClose();
              })
              .catch((reason) => {
                setError(String(reason));
                setBusy(false);
              });
          }}
        >
          <MemoryEditor
            directory={directory}
            value={draft}
            onChange={setDraft}
            disabled={busy || saved}
          />
          {saved && <p role="status">{t(pendingSync ? "memory.savedPending" : "memory.savedWithFallback")}</p>}
          {error && <p role="alert">{t(memoryError(error))}</p>}
          <button
            className="button button--primary"
            disabled={
              busy ||
              saved ||
              !snapshot ||
              !draft.content.trim() ||
              memoryBytes(draft.content) > 8192 ||
              maskNativeText(draft.content) !== draft.content ||
              draft.content.includes("[REDACTED]")
            }
          >
            {t("chat.instructions.save")}
          </button>
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={onClose}
          >
            {t(saved ? "common.close" : "common.cancel")}
          </button>
        </form>
      </div>
    </div>,
    document.body,
  );
}
export function MemorySaveButton({
  text,
  directory = "",
  cli = null,
  conversationId = null,
}: {
  text: string;
  directory?: string;
  cli?: string | null;
  conversationId?: string | null;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="chat-msg__branch"
        title={t("memory.saveMessage")}
        aria-label={t("memory.saveMessage")}
        onClick={() => setOpen(true)}
      >
        {t("memory.saveMessage")}
      </button>
      {open && (
        <SaveDialog
          key={`${directory}:${conversationId}`}
          text={text}
          directory={directory}
          cli={cli}
          conversationId={conversationId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
