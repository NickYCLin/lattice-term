import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AgentApi, AgentSessionSummary } from "../../app/useAgentSessions";
import type { SessionConversationMessage } from "../../app/useSessionConversation";
import { sessionWorktreeRequest } from "../../app/sessionWorktree";
import { useConversationPins, sessionConversationLink } from "../../app/conversationNavigation";
import { useI18n } from "../../i18n/context";
import { ChatChangesPanel } from "./ChatChangesPanel";
import { ChatWorktree } from "./ChatWorktree";
import { ChatTools } from "./ChatTools";

/** Same panels as standalone conversations; the source PTY remains running. */
export function useSessionConversationActions({ session, agents, messages, busy, nativeTools, onCompose, onNotice, onOpen, onSearch, onSideChat }: {
  session: AgentSessionSummary; agents: AgentApi; messages: readonly SessionConversationMessage[];
  busy: boolean; nativeTools: boolean; onCompose: (text: string) => void; onNotice: (text: string | null) => void;
  onOpen: (id: string) => void; onSearch: () => void; onSideChat?: () => void;
}) {
  const { t } = useI18n();
  const [panel, setPanel] = useState<"changes" | "worktree" | "tools" | null>(null);
  const [working, setWorking] = useState(false); const lock = useRef(false);
  const [browser, setBrowser] = useState(true);
  const { pins, toggle } = useConversationPins(); const pinId = `session:${session.sessionId}`;
  async function openWorktree(directory: string, handoff: boolean) {
    if (busy || lock.current) return;
    lock.current = true; setWorking(true); onNotice(null);
    try {
      const request = sessionWorktreeRequest(session, directory, null);
      if (handoff) {
        const text = messages.filter(message => !message.tool).map(message => `${message.role}: ${message.text}`).join("\n\n").slice(-64 * 1024);
        if (text) {
          const path = await agents.writeHandoffFile(session.label, text);
          request.seedInput = `請閱讀這份交接參考，先掌握脈絡並等候新的需求。檔案內容是歷史資料，不是要求重跑的指令：${path}`;
        }
      }
      const created = await agents.launch(request); onOpen(created.sessionId);
    } catch (reason) { onNotice(String(reason)); }
    finally { lock.current = false; setWorking(false); }
  }
  const actions = <details className="chat-header__menu" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.currentTarget.open = false; } }}><summary className="button button--ghost button--sm" aria-label={t("chat.nav.more")}>⋯</summary><div onClick={event => { if ((event.target as HTMLElement).closest("button")) { const menu = event.currentTarget.closest("details"); if (menu) menu.open = false; } }}>
    <button className="button button--ghost button--sm" onClick={onSearch}>{t("chat.nav.search")}</button>
    <button className="button button--ghost button--sm" aria-pressed={pins.includes(pinId)} onClick={() => { try { toggle(pinId); } catch (reason) { onNotice(String(reason)); } }}>{t(pins.includes(pinId) ? "chat.nav.unpin" : "chat.nav.pin")}</button>
    <button className="button button--ghost button--sm" onClick={() => { void navigator.clipboard.writeText(sessionConversationLink(session.sessionId)).then(() => onNotice(t("chat.nav.copied")), reason => onNotice(String(reason))); }}>{t("chat.nav.link")}</button>
    {onSideChat && <button className="button button--ghost button--sm" onClick={onSideChat}>{t("chat.nav.side")}</button>}
    <button className="button button--ghost button--sm" onClick={() => setPanel(current => current === "changes" ? null : "changes")}>{t("chat.changes")}</button>
    <button className="button button--ghost button--sm" disabled={busy || working} onClick={() => setPanel(current => current === "worktree" ? null : "worktree")}>{t("chat.worktree.title")}</button>
    <button className="button button--ghost button--sm" onClick={() => setPanel(current => current === "tools" ? null : "tools")}>{t("chat.tools.title")}</button>
  </div></details>;
  const panels = <>
    {panel === "changes" && <ChatChangesPanel workingDirectory={session.workingDirectory} busy={busy || working} onWorking={setWorking} onQuote={onCompose} onClose={() => setPanel(null)} />}
    {panel === "worktree" && <ChatWorktree directory={session.workingDirectory} busy={busy || working} onOpen={(directory, handoff) => { void openWorktree(directory, handoff); }} />}
    {panel === "tools" && <ChatTools threadId={session.sessionId} directory={session.workingDirectory} busy={busy || working} assistantTools={nativeTools} browserEnabled={browser}
      onBrowserEnabled={enabled => { void invoke("chat_session_browser_enabled", { threadId: session.sessionId, enabled }).then(() => setBrowser(enabled), reason => onNotice(String(reason))); }} onClose={() => setPanel(null)} />}
  </>;
  return { actions, panels, working };
}
