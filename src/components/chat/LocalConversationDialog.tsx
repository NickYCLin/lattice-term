import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import type { AgentApi } from "../../app/useAgentSessions";
import type { AgentChatApi } from "../../app/useAgentChat";
import { parseConversationArchive, type ArchivedConversation } from "../../app/conversationArchive";
import { useChatAccountProfiles } from "../../app/useChatAccountProfiles";
import { useI18n } from "../../i18n/context";
import { CloseIcon } from "../icons";
import { useModalFocus } from "../overlays/modalFocus";

interface Conversation {
  definitionId: "codex" | "claude";
  profileId: string | null;
  nativeSessionId: string;
  workingDirectory: string;
  resumable: boolean;
  title: string;
  updatedAt: number;
}

interface Message {
  role: "user" | "assistant";
  text: string;
}

export function LocalConversationDialog({ agents, chat, onClose, onOpenChat, onOpenSession }: {
  agents: AgentApi;
  chat: AgentChatApi | null;
  onClose: () => void;
  onOpenChat: () => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const { t } = useI18n();
  const profiles = useChatAccountProfiles();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [entries, setEntries] = useState<Conversation[]>([]);
  const [archives, setArchives] = useState<ArchivedConversation[]>([]);
  const [selectedArchive, setSelectedArchive] = useState<ArchivedConversation | null>(null);
  const [selectedStoredId, setSelectedStoredId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const profileArgs = profiles.map(({ id, definitionId, configDirectory }) => ({
    profileId: id, definitionId, configDirectory,
  }));
  const profileArgsRef = useRef(profileArgs);
  profileArgsRef.current = profileArgs;
  const selectionRef = useRef(0);

  useModalFocus({ dialogRef, getInitialFocus: () => closeRef.current, onEscape: onClose, escapeDisabled: launching });

  useEffect(() => {
    let active = true;
    const request = selectionRef.current;
    invoke<Conversation[]>("agent_chat_local_history", { profiles: profileArgsRef.current })
      .then((found) => { if (active && request === selectionRef.current) setEntries(found); })
      .catch((reason) => { if (active && request === selectionRef.current) setError(String(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; selectionRef.current++; };
  }, []);

  async function select(entry: Conversation) {
    const request = ++selectionRef.current;
    setSelected(entry);
    setSelectedArchive(null);
    setSelectedStoredId(null);
    setMessages([]);
    setError(null);
    setBusy(true);
    try {
      const found = await invoke<Message[]>("agent_chat_local_history_read", {
        definitionId: entry.definitionId,
        nativeSessionId: entry.nativeSessionId,
        profileId: entry.profileId,
        profiles: profileArgsRef.current,
      });
      if (request === selectionRef.current) setMessages(found);
    } catch (reason) {
      if (request === selectionRef.current) setError(String(reason));
    } finally {
      if (request === selectionRef.current) setBusy(false);
    }
  }

  function openChat() {
    if (!selected || !selected.resumable || !chat || busy || error) return;
    chat.importNativeConversation({
      definitionId: selected.definitionId,
      nativeSessionId: selected.nativeSessionId,
      workingDirectory: selected.workingDirectory,
      title: selected.title,
      accountProfileId: selected.profileId,
      messages,
    });
    onOpenChat();
    onClose();
  }

  async function importFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (file.size > 8 * 1024 * 1024) {
      setError(t("history.exportTooLarge"));
      return;
    }
    try {
      const result = parseConversationArchive(JSON.parse(await file.text()) as unknown);
      if (!result.length) throw new Error(t("history.exportEmpty"));
      selectionRef.current++;
      setEntries([]);
      setSelected(null);
      setArchives(result);
      setSelectedArchive(result[0]);
      setSelectedStoredId(null);
      setMessages([]);
    } catch (reason) {
      setError(String(reason));
    }
  }

  function openArchive() {
    if (!chat) return;
    if (selectedStoredId) chat.setActiveThreadId(selectedStoredId);
    else if (selectedArchive) chat.importArchivedConversation(selectedArchive);
    else return;
    onOpenChat();
    onClose();
  }

  async function openSession() {
    if (!selected || !selected.resumable || busy || error) return;
    const installed = agents.catalog.find((entry) => entry.id === selected.definitionId && entry.installed);
    if (!installed) return;
    setBusy(true);
    setLaunching(true);
    setError(null);
    try {
      const profile = profiles.find((entry) =>
        entry.id === selected.profileId && entry.definitionId === selected.definitionId);
      if (selected.profileId && !profile) throw new Error(t("history.profileMissing"));
      const launched = await agents.launch({
        definitionId: selected.definitionId,
        label: selected.title,
        executable: "",
        arguments: [],
        resumeSessionId: selected.nativeSessionId,
        restoreExistingSession: true,
        profileConfigPath: profile?.configDirectory ?? null,
        workingDirectory: selected.workingDirectory,
        cols: 120,
        rows: 32,
      });
      onOpenSession(launched.sessionId);
      onClose();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
      setLaunching(false);
    }
  }

  const installed = selected && agents.catalog.some((entry) => entry.id === selected.definitionId && entry.installed);
  const storedArchives = chat?.threads.filter((thread) => thread.archived) ?? [];
  const selectedStored = storedArchives.find((thread) => thread.id === selectedStoredId);
  return (
    <div className="scrim scrim--center" role="presentation" onMouseDown={() => { if (!launching) onClose(); }}>
      <div ref={dialogRef} className="dialog dialog--wide local-history" role="dialog" aria-modal="true"
        aria-labelledby="local-history-title" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog__head">
          <h2 className="dialog__title" id="local-history-title">{t("history.title")}</h2>
          <button ref={closeRef} type="button" className="icon-button icon-button--sm" style={{ marginLeft: "auto" }}
            aria-label={t("common.close")} disabled={launching} onClick={onClose}><CloseIcon size={14} /></button>
        </header>
        <p className="dialog__body">{t("history.intro")}</p>
        <label className="dialog__body">{t("history.importExport")}{" "}
          <input type="file" accept=".json,application/json" disabled={launching} onChange={(event) => void importFile(event.currentTarget.files?.[0])} />
        </label>
        <div className="local-history__columns">
          <div className="local-history__list" aria-label={t("history.title")}>
            {storedArchives.map((entry) => (
              <button type="button" key={`stored:${entry.id}`} disabled={launching} className={`local-history__entry${selectedStoredId === entry.id ? " is-active" : ""}`}
                onClick={() => { selectionRef.current++; setBusy(false); setSelected(null); setSelectedArchive(null); setSelectedStoredId(entry.id); setError(null); }}>
                <strong>{entry.title}</strong><small>{t("history.archive")}</small>
              </button>
            ))}
            {archives.length > 0 ? archives.map((entry, index) => (
              <button type="button" key={`archive:${index}`} disabled={launching} className={`local-history__entry${selectedArchive === entry ? " is-active" : ""}`}
                onClick={() => { selectionRef.current++; setBusy(false); setSelected(null); setSelectedStoredId(null); setSelectedArchive(entry); setError(null); }}>
                <strong>{entry.title}</strong><small>{entry.definitionId === "codex" ? "ChatGPT / Codex" : "Claude"} · {t("history.archive")}</small>
              </button>
            )) : loading ? <p>{t("common.loading")}</p> : entries.length === 0 && !storedArchives.length ? <p>{t("history.empty")}</p> : entries.map((entry) => (
              <button type="button" key={`${entry.definitionId}:${entry.profileId}:${entry.nativeSessionId}`} disabled={launching}
                className={`local-history__entry${selected?.nativeSessionId === entry.nativeSessionId && selected?.definitionId === entry.definitionId && selected?.profileId === entry.profileId ? " is-active" : ""}`}
                onClick={() => void select(entry)}>
                <strong>{entry.title}</strong>
                <small>{entry.definitionId === "codex" ? "Codex" : "Claude Code"} · {new Date(entry.updatedAt * 1000).toLocaleString()}</small>
              </button>
            ))}
          </div>
          <div className="local-history__preview">
            {selected && <><p className="dialog__body mono">{selected.workingDirectory}</p>
              {!selected.resumable && <p className="dialog__body">{t("history.directoryMissing")}</p>}
              {busy && !messages.length ? <p>{t("common.loading")}</p> : messages.map((message, index) => (
                <div key={index} className="local-history__message">
                  <strong>{message.role === "user" ? t("history.user") : t("history.assistant")}</strong>
                  <p>{message.text}</p>
                </div>
              ))}</>}
            {selectedArchive?.messages.map((message, index) => (
              <div key={index} className="local-history__message">
                <strong>{message.role === "user" ? t("history.user") : t("history.assistant")}</strong>
                <p>{message.text}</p>
              </div>
            ))}
            {selectedStored?.items.map((item) => item.type === "user" || item.type === "text" ? (
              <div key={item.id} className="local-history__message">
                <strong>{item.type === "user" ? t("history.user") : t("history.assistant")}</strong>
                <p>{item.text}</p>
              </div>
            ) : null)}
          </div>
        </div>
        {error && <p className="dialog__body" role="alert">{error}</p>}
        <p className="dialog__body">{t("history.concurrent")}</p>
        <p className="dialog__body">{t("history.cloud")}{" "}
          <a href="https://chatgpt.com/codex" target="_blank" rel="noopener noreferrer">Codex</a>{" · "}
          <a href="https://claude.ai/" target="_blank" rel="noopener noreferrer">Claude</a>
        </p>
        <div className="dialog__actions">
          <button type="button" className="button button--ghost" disabled={launching} onClick={onClose}>{t("common.close")}</button>
          <button type="button" className="button button--ghost" onClick={() => void openSession()}
            disabled={!selected?.resumable || !installed || busy || Boolean(error)}>{t("history.openSession")}</button>
          <button type="button" className="button button--primary" onClick={selectedArchive || selectedStoredId ? openArchive : openChat}
            disabled={(!selectedArchive && !selectedStoredId && (!selected?.resumable || !installed || busy)) || !chat || Boolean(error)}>
            {selectedStoredId ? t("history.viewArchive") : selectedArchive ? t("history.importArchive") : t("history.openChat")}
          </button>
        </div>
      </div>
    </div>
  );
}
