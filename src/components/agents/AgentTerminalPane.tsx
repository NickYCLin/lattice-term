import { useMemo } from "react";
import type { AgentApi } from "../../app/useAgentSessions";
import type { ThemeId } from "../../app/themes";
import { useI18n } from "../../i18n/context";
import { PtyTerminal, type PtyTerminalIo } from "../terminal/PtyTerminal";

export function AgentTerminalPane({
  sessionId,
  agents,
  theme,
}: {
  sessionId: string;
  agents: AgentApi;
  theme: ThemeId;
}) {
  const { t } = useI18n();
  const io = useMemo<PtyTerminalIo>(
    () => ({
      send: (data) => agents.send(sessionId, data),
      resize: (cols, rows) => agents.resize(sessionId, cols, rows),
      onData: (handler) => agents.onData(sessionId, handler),
      onClosed: (handler) => agents.onClosed(sessionId, handler),
      closedReason: () =>
        agents.sessions.find((session) => session.sessionId === sessionId)?.closedReason,
      // The agent runs locally, so an image on the clipboard can be written to
      // a temp file and its path pasted in — the shape CLIs like Claude Code
      // and Gemini accept for attaching an image.
      pasteImage: () => agents.pasteClipboardImage(sessionId),
    }),
    [agents, sessionId],
  );
  return (
    <PtyTerminal
      ioKey={sessionId}
      io={io}
      theme={theme}
      inputFailedText={t("agents.terminal.inputFailed")}
      className="agent-terminal"
    />
  );
}
