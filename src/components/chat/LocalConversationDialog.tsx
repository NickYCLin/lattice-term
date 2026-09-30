import { useEffect, useRef, useState } from "react";
import type { AgentApi } from "../../app/useAgentSessions";
import type { AgentChatApi } from "../../app/useAgentChat";
import { parseConversationArchive, type ArchivedConversation } from "../../app/conversationArchive";
import { useChatAccountProfiles } from "../../app/useChatAccountProfiles";
import { useI18n } from "../../i18n/context";
import { CloseIcon } from "../icons";
import { useModalFocus } from "../overlays/modalFocus";
import { conversationSession, isProxyConversation, nativeConversationProxy, localConversationLaunchIntents, type LocalConversation } from "../../app/localConversationSessions";
import { nativeConversationKey, useNativeHistory, useNativeConversations, useNativeConversationMessages } from "../../app/useNativeConversations";
import { useCliProxySettings } from "../../app/useCliProxyApi";

type Conversation = LocalConversation;

export function LocalConversationDialog({ agents, chat, onClose, onOpenChat, onOpenSession, onOpenSessionChat, initialSelection = null }: {
  agents: AgentApi;
  chat: AgentChatApi | null;
  onClose: () => void;
  onOpenChat: () => void;
  onOpenSession: (sessionId: string) => void;
  onOpenSessionChat?: (sessionId: string) => void;
  initialSelection?: LocalConversation | null;
}) {
  const { t } = useI18n();
  const profiles = useChatAccountProfiles();
  const { proxies } = useCliProxySettings();
  const [proxyId, setProxyId] = useState("");
  const shared = useNativeHistory();
  const fallback = useNativeConversations(!shared && agents.mode === "ready");
  const history = shared ?? fallback;
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const entries = history.entries;
  const [archives, setArchives] = useState<ArchivedConversation[]>([]);
  const [selectedArchive, setSelectedArchive] = useState<ArchivedConversation | null>(null);
  const [selectedStoredId, setSelectedStoredId] = useState<string | null>(null);
  const [selection, setSelected] = useState<Conversation | null>(initialSelection);
  const sourceSelection = selection && (entries.find(entry => nativeConversationKey(entry) === nativeConversationKey(selection)) ?? selection);
  const reader = useNativeConversationMessages(sourceSelection, history.profileKey);
  const selected = sourceSelection && reader.value?.archived !== undefined
    ? { ...sourceSelection, archived: reader.value.archived, resumable: sourceSelection.resumable && !reader.value.archived }
    : sourceSelection;
  const messages = reader.value?.messages ?? [];
  const loading = history.busy && !history.value;
  const [busy, setBusy] = useState(false);
  const [launching, setLaunching] = useState(false);
  const launchInFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const requiresProxy = selected !== null && isProxyConversation(selected);
  const selectedProxy = proxies.find(proxy => proxy.id === proxyId);
  const existingSession = selected && conversationSession(selected, profiles, agents.sessions, true);
  const missingProxy = requiresProxy && !selectedProxy && !existingSession;

  useModalFocus({ dialogRef, getInitialFocus: () => closeRef.current, onEscape: onClose, escapeDisabled: launching });

  useEffect(() => { history.refresh(); }, []);
  useEffect(() => {
    setProxyId(selected ? nativeConversationProxy(selected, proxies)?.id ?? "" : "");
  }, [selected?.nativeSessionId, selected?.profileId, selected?.definitionId]);

  function select(entry: Conversation) {
    setSelected(entry);
    setProxyId(nativeConversationProxy(entry, proxies)?.id ?? "");
    setSelectedArchive(null); setSelectedStoredId(null); setError(null);
  }

  function openChat() {
    if (onOpenSessionChat) { void openSession(true); return; }
    if (!selected || !selected.resumable || !chat || busy || error || missingProxy || !reader.value || reader.error) return;
    chat.importNativeConversation({
      definitionId: selected.definitionId,
      nativeSessionId: selected.nativeSessionId,
      workingDirectory: selected.workingDirectory,
      title: selected.title,
      accountProfileId: selected.profileId,
      messages,
      ...(requiresProxy && selectedProxy ? { provider: "cliproxyapi" as const, proxyId: selectedProxy.id } : {}),
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
      setSelected(null);
      setArchives(result);
      setSelectedArchive(result[0]);
      setSelectedStoredId(null);
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

  async function openSession(inChat = false) {
    if (!selected || !selected.resumable || busy || error || missingProxy || launchInFlight.current || !reader.value || reader.error) return;
    const open = inChat && onOpenSessionChat ? onOpenSessionChat : onOpenSession;
    const existing = conversationSession(selected, profiles, agents.sessions, true);
    if (existing) { open(existing.sessionId); onClose(); return; }
    const installed = agents.catalog.find((entry) => entry.id === selected.definitionId && entry.installed);
    if (!installed) return;
    launchInFlight.current = true;
    setBusy(true);
    setLaunching(true);
    setError(null);
    try {
      const profile = profiles.find((entry) =>
        entry.id === selected.profileId && entry.definitionId === selected.definitionId);
      if (selected.profileId && !profile) throw new Error(t("history.profileMissing"));
      const intent = localConversationLaunchIntents([selected], profiles, agents.catalog, [], [], proxies, selectedProxy)[0];
      if (!intent) throw new Error(t("history.profileMissing"));
      const launched = await agents.launch({
        definitionId: selected.definitionId,
        label: intent.groupLabel,
        groupId: intent.groupKey,
        executable: "",
        arguments: intent.launchArguments,
        resumeSessionId: selected.nativeSessionId,
        restoreExistingSession: true,
        profileConfigPath: profile?.configDirectory ?? null,
        workingDirectory: selected.workingDirectory,
        cols: 120,
        rows: 32,
      });
      open(launched.sessionId);
      onClose();
    } catch (reason) {
      setError(String(reason));
    } finally {
      launchInFlight.current = false;
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
        <p className="dialog__body">{t("history.readOnlySync")}</p>
        <button type="button" className="button button--ghost" disabled={history.busy} onClick={history.refresh}>{t("history.refresh")}</button>
        <label><input type="checkbox" checked={history.includeArchived} disabled={launching}
          onChange={event => history.setIncludeArchived(event.target.checked)} /> {t("history.includeArchived")}</label>
        {history.incomplete && <p className="dialog__body" role="status">{t("history.incomplete")}</p>}
        {history.error && <p className="dialog__body" role="alert">{t("history.stale")} {history.error}</p>}
        <label className="dialog__body">{t("history.importExport")}{" "}
          <input type="file" accept=".json,application/json" disabled={launching || loading} onChange={(event) => void importFile(event.currentTarget.files?.[0])} />
        </label>
        <div className="local-history__columns">
          <div className="local-history__list" aria-label={t("history.title")}>
            {history.hasMore && !loading && <button type="button" className="button button--secondary" disabled={launching || busy} onClick={history.loadMore}>{t("history.loadOlder")}</button>}
            {storedArchives.map((entry) => (
              <button type="button" key={`stored:${entry.id}`} disabled={launching} className={`local-history__entry${selectedStoredId === entry.id ? " is-active" : ""}`}
                onClick={() => { setBusy(false); setSelected(null); setSelectedArchive(null); setSelectedStoredId(entry.id); setError(null); }}>
                <strong>{entry.title}</strong><small>{t("history.archive")}</small>
              </button>
            ))}
            {archives.length > 0 ? archives.map((entry, index) => (
              <button type="button" key={`archive:${index}`} disabled={launching} className={`local-history__entry${selectedArchive === entry ? " is-active" : ""}`}
                onClick={() => { setBusy(false); setSelected(null); setSelectedStoredId(null); setSelectedArchive(entry); setError(null); }}>
                <strong>{entry.title}</strong><small>{entry.definitionId === "codex" ? "ChatGPT / Codex" : "Claude"} · {t("history.archive")}</small>
              </button>
            )) : loading ? <p>{t("common.loading")}</p> : entries.length === 0 && !storedArchives.length ? <p>{t("history.empty")}</p> : entries.map((entry) => (
              <button type="button" key={`${entry.definitionId}:${entry.profileId}:${entry.nativeSessionId}`} disabled={launching}
                className={`local-history__entry${selected?.nativeSessionId === entry.nativeSessionId && selected?.definitionId === entry.definitionId && selected?.profileId === entry.profileId ? " is-active" : ""}`}
                onClick={() => void select(entry)}>
                <strong>{entry.title}</strong>
                <small>{entry.definitionId === "codex" ? "Codex" : "Claude Code"} · {new Date(entry.updatedAt * 1000).toLocaleString()}{entry.archived ? ` · ${t("history.nativeArchived")}` : ""}</small>
              </button>
            ))}
          </div>
          <div className="local-history__preview">
            {selected && <><h3>{selected.title}</h3>
              <p>{t("history.stateUnknown")} · {selected.archived ? t("history.nativeArchived") : t("history.textOnly")}</p>
              {selected.titleSource !== "nativeIndex" && <p>{t("history.titleFallback")}</p>}
              {reader.error && <p role="alert">{t("history.stale")} {reader.error}</p>}
              {reader.value?.truncated && <p role="status">{t("history.truncated")}</p>}
              <p className="dialog__body mono">{selected.workingDirectory}</p>
              {requiresProxy && !selected.archived && <label className="dialog__body">{t("history.proxyConnection")}
                <select className="select" value={proxyId} disabled={launching} onChange={event => setProxyId(event.target.value)}>
                  <option value="">{t("history.proxyChoose")}</option>
                  {proxies.map(proxy => <option key={proxy.id} value={proxy.id}>{proxy.label || proxy.baseUrl}</option>)}
                </select>
                <p>{t(proxies.length ? "history.proxyHint" : "history.proxyMissing")}</p>
              </label>}
              {!selected.resumable && <p className="dialog__body">{t(selected.archived ? "history.nativeArchivedHint" : "history.directoryMissing")}</p>}
              {(busy || reader.busy) && !messages.length ? <p>{t("common.loading")}</p> : messages.map((message, index) => (
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
            disabled={!selected?.resumable || !installed || busy || loading || missingProxy || !reader.value || Boolean(error || reader.error)}>{t("history.resumeSessionExplicit")}</button>
          <button type="button" className="button button--primary" onClick={selectedArchive || selectedStoredId ? openArchive : openChat}
            disabled={(!selectedArchive && !selectedStoredId && (!selected?.resumable || !installed || busy || loading || missingProxy || !reader.value)) || !chat || Boolean(error || reader.error)}>
            {selectedStoredId ? t("history.viewArchive") : selectedArchive ? t("history.importArchive") : t("history.resumeChatExplicit")}
          </button>
        </div>
      </div>
    </div>
  );
}
