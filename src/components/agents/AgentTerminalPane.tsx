import { useMemo, useState } from "react";
import type { AgentApi } from "../../app/useAgentSessions";
import type { ThemeId } from "../../app/themes";
import { useI18n } from "../../i18n/context";
import { PtyTerminal, type PtyTerminalIo } from "../terminal/PtyTerminal";
import { AgentSessionImages } from "./AgentSessionImages";

export function AgentTerminalPane({
  sessionId,
  agents,
  theme,
  active,
}: {
  sessionId: string;
  agents: AgentApi;
  theme: ThemeId;
  active: boolean;
}) {
  const { t } = useI18n();
  const [imageRevision, setImageRevision] = useState(0);
  const [openImagesRevision, setOpenImagesRevision] = useState(0);
  const io = useMemo<PtyTerminalIo>(
    () => ({
      send: (data) => agents.send(sessionId, data),
      sendEscape: agents.sendEscape ? () => agents.sendEscape!(sessionId) : undefined,
      resize: (cols, rows) => agents.resize(sessionId, cols, rows),
      onData: (handler) => agents.onData(sessionId, handler),
      onClosed: (handler) => agents.onClosed(sessionId, handler),
      closedReason: () =>
        agents.sessions.find((session) => session.sessionId === sessionId)?.closedReason,
      // The agent runs locally, so an image on the clipboard can be written to
      // a temp file and its path pasted in — the shape CLIs like Claude Code
      // and Gemini accept for attaching an image.
      pasteImage: async () => {
        const path = await agents.pasteClipboardImage(sessionId);
        if (path) setImageRevision(value => value + 1);
        return path;
      },
      openImages: () => setOpenImagesRevision(value => value + 1),
    }),
    [agents, sessionId],
  );
  return (
    <div className="agent-terminal-pane">
      <AgentSessionImages key={sessionId} sessionId={sessionId} active={active} revision={imageRevision} openRevision={openImagesRevision} />
      <PtyTerminal
      ioKey={sessionId}
      io={io}
      theme={theme}
      inputFailedText={t("agents.terminal.inputFailed")}
      className="agent-terminal"
      />
    </div>
  );
}
