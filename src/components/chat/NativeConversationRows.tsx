import { useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AgentChatApi } from "../../app/useAgentChat";
import { agentDisplayName } from "../../app/agentNames";
import { isProxyConversation, nativeConversationProxy, type LocalConversation } from "../../app/localConversationSessions";
import { useCliProxySettings } from "../../app/useCliProxyApi";
import { nativeConversationKey, useNativeHistory, type NativeMessageSnapshot } from "../../app/useNativeConversations";
import { useI18n } from "../../i18n/context";
import { chatProjectKey } from "../../app/chatProjects";
import { displayPath } from "../../app/displayPath";
import { ConversationListIdentity } from "./ConversationPresentation";
import { FolderIcon } from "../icons";
import { ConversationReadProgress } from "./ConversationReadProgress";

function directoryKey(path: string) {
  return path.replace(/[\\/]+$/, "") || path;
}

function directoryName(path: string) {
  const trimmed = directoryKey(path);
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
}

/**
 * Conversations a CLI keeps in its own history appear in the list as they
 * are. Nothing is stored until one is opened; from then on it is an ordinary
 * thread whose text follows the CLI's history.
 */
export function useNativeConversationList({ chat, projectFilter, onOpened }: {
  chat: AgentChatApi;
  projectFilter: string | null;
  onOpened: () => void;
}) {
  const history = useNativeHistory();
  const { proxies } = useCliProxySettings();
  const { t } = useI18n();
  const [opening, setOpening] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ key: string; detail: string } | null>(null);
  const [reading, setReading] = useState<{ key: string; snapshot: NativeMessageSnapshot | null } | null>(null);
  const inFlight = useRef(false);
  const known = useMemo(() => new Set(chat.threads.filter(thread => thread.nativeSessionId).map(thread => nativeConversationKey({
    definitionId: thread.definitionId, profileId: thread.accountProfileId ?? null, nativeSessionId: thread.nativeSessionId!,
  }))), [chat.threads]);
  const rows = useMemo(() => (history?.entries ?? []).filter(entry =>
    !entry.archived && !known.has(nativeConversationKey(entry)) &&
    (projectFilter === null || chatProjectKey(entry.workingDirectory) === chatProjectKey(projectFilter))), [history?.entries, known, projectFilter]);

  async function open(entry: LocalConversation, retry = false) {
    if (!history) return;
    const key = nativeConversationKey(entry);
    if (entry.definitionId !== "cursor") {
      const proxy = isProxyConversation(entry) ? nativeConversationProxy(entry, proxies) : undefined;
      chat.importNativeConversation({
        definitionId: entry.definitionId, nativeSessionId: entry.nativeSessionId,
        workingDirectory: entry.workingDirectory, title: entry.title,
        accountProfileId: entry.profileId, messages: [],
        ...(proxy ? { provider: "cliproxyapi" as const, proxyId: proxy.id } : {}),
      });
      onOpened();
      return;
    }
    if (inFlight.current) return;
    if (reading?.key === key && !retry) {
      setReading(null);
      return;
    }
    inFlight.current = true;
    setOpening(key);
    setFailed(null);
    setReading({ key, snapshot: null });
    try {
      const snapshot = await invoke<NativeMessageSnapshot>("agent_chat_local_history_snapshot", {
        definitionId: entry.definitionId, nativeSessionId: entry.nativeSessionId,
        profileId: entry.profileId, profiles: JSON.parse(history.profileKey),
      });
      // Cursor keeps editor chats that no CLI here can continue, so they are
      // shown in place rather than becoming a thread with a composer.
      setReading({ key, snapshot });
    } catch (reason) {
      setFailed({ key, detail: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      inFlight.current = false;
      setOpening(null);
    }
  }

  function renderEntry(entry: LocalConversation) {
    if (!history) return null;
    const key = nativeConversationKey(entry);
    return <div className="chat-native-entry">
      <button type="button" className="chat-thread" disabled={entry.definitionId === "cursor" && opening !== null} aria-busy={opening === key}
        aria-expanded={entry.definitionId === "cursor" ? reading?.key === key : undefined}
        title={displayPath(entry.workingDirectory)} onClick={() => void open(entry)}>
        <ConversationListIdentity title={entry.title || t("chat.untitled")}>
            {agentDisplayName(entry.definitionId)}
            {entry.profileId ? ` · ${history.profiles.find(profile => profile.id === entry.profileId)?.name ?? entry.profileId}` : ""}
            {entry.workingDirectory ? ` · ${directoryName(entry.workingDirectory)}` : ""}
        </ConversationListIdentity>
      </button>
      {reading?.key === key && <div className="chat-native-rows__reader" role="region" aria-label={entry.title || t("chat.untitled")}>
        <p className="chat-native-rows__hint">{t("history.cursorReadOnly")}</p>
        <ConversationReadProgress loading={opening === key} error={failed?.key === key ? failed.detail : null} onRetry={() => void open(entry, true)} />
        {reading.snapshot?.truncated && <p className="chat-native-rows__hint">{t("history.truncated")}</p>}
        {reading.snapshot?.messages.map((message, index) =>
          <p key={index} className={`chat-native-rows__message chat-native-rows__message--${message.role}`}>{message.text}</p>)}
      </div>}
    </div>;
  }

  const footer = history && <>
    {history.error && <p className="chat-threads__hint" role="alert">{t("history.stale")} {history.error}</p>}
    {history.hasMore && <button type="button" className="button button--ghost button--sm" disabled={history.busy} onClick={history.loadMore}>
      {t("history.loadOlder")}
    </button>}
  </>;
  return { rows, renderEntry, footer };
}

export function NativeConversationRows(props: Parameters<typeof useNativeConversationList>[0]) {
  const { rows, renderEntry, footer } = useNativeConversationList(props);
  const { t } = useI18n();
  const groups = new Map<string, LocalConversation[]>();
  for (const entry of rows) {
    const directory = chatProjectKey(entry.workingDirectory);
    groups.set(directory, [...(groups.get(directory) ?? []), entry]);
  }
  return <>
    {[...groups].map(([directory, entries]) => <details key={directory} className="chat-native-project" open>
      <summary title={displayPath(directory)}><FolderIcon size={14} />
        <span>{directory ? directoryName(directory) : t("chat.directory.none")}</span>
        <small>{entries.length}</small>
      </summary>
      <ul className="chat-native-rows">{entries.map(entry => <li key={nativeConversationKey(entry)}>{renderEntry(entry)}</li>)}</ul>
    </details>)}
    {footer}
  </>;
}
