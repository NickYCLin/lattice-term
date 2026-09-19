import { useEffect, useMemo, useState } from "react";
import {
  closeLocalTerminal,
  onLocalTerminalData,
  onLocalTerminalExit,
  openLocalTerminal,
  resizeLocalTerminal,
  writeLocalTerminal,
} from "../../app/localTerminal";
import { displayPath } from "../../app/displayPath";
import type { ThemeId } from "../../app/themes";
import { useI18n } from "../../i18n/context";
import { PtyTerminal, type PtyTerminalIo } from "../terminal/PtyTerminal";
import { CloseIcon, RefreshIcon } from "../icons";

/**
 * The user's own shell in the conversation's folder, docked under the
 * messages. It lives exactly as long as the panel: hiding the panel ends it.
 */
export function ChatTerminalPanel({
  workingDirectory,
  theme,
  onClose,
}: {
  workingDirectory: string;
  theme: ThemeId;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let opened: string | null = null;
    setTerminalId(null);
    setError("");
    openLocalTerminal(workingDirectory)
      .then((id) => {
        if (cancelled) {
          void closeLocalTerminal(id).catch(() => {});
          return;
        }
        opened = id;
        setTerminalId(id);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(String(reason));
      });
    return () => {
      cancelled = true;
      if (opened) void closeLocalTerminal(opened).catch(() => {});
    };
  }, [workingDirectory, generation]);

  const io = useMemo<PtyTerminalIo | null>(
    () =>
      terminalId
        ? {
            send: (data) => writeLocalTerminal(terminalId, data),
            resize: (cols, rows) => resizeLocalTerminal(terminalId, cols, rows),
            onData: (handler) => onLocalTerminalData(terminalId, handler),
            onClosed: (handler) =>
              onLocalTerminalExit(terminalId, (code) =>
                handler(t("chat.terminal.exited", { code: code ?? "?" })),
              ),
          }
        : null,
    [terminalId, t],
  );

  return (
    <section className="chat-terminal" aria-label={t("chat.terminal")}>
      <header className="chat-terminal__head">
        <span className="chat-card__label">{t("chat.terminal")}</span>
        <code className="chat-terminal__path" title={workingDirectory}>
          {workingDirectory ? displayPath(workingDirectory) : "~"}
        </code>
        <button
          type="button"
          className="button button--ghost button--sm"
          onClick={() => setGeneration((current) => current + 1)}
          aria-label={t("chat.terminal.restart")}
          title={t("chat.terminal.restart")}
        >
          <RefreshIcon />
        </button>
        <button
          type="button"
          className="button button--ghost button--sm"
          onClick={onClose}
          aria-label={t("chat.terminal.close")}
          title={t("chat.terminal.close")}
        >
          <CloseIcon />
        </button>
      </header>
      {error && <p className="field__error">{error}</p>}
      {io && terminalId && (
        <PtyTerminal
          ioKey={terminalId}
          io={io}
          theme={theme}
          inputFailedText={t("chat.terminal.inputFailed")}
          className="chat-terminal__screen"
        />
      )}
    </section>
  );
}
