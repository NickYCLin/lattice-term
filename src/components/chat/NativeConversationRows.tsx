import { useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AgentChatApi } from "../../app/useAgentChat";
import { agentDisplayName } from "../../app/agentNames";
import { isProxyConversation, nativeConversationProxy, type LocalConversation } from "../../app/localConversationSessions";
import { useCliProxySettings } from "../../app/useCliProxyApi";
import { nativeConversationKey, useNativeHistory, type NativeMessageSnapshot } from "../../app/useNativeConversations";
import { useI18n } from "../../i18n/context";
import { chatProjectKey } from "../../app/chatProjects";

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
export function NativeConversationRows({ chat, projectFilter, onOpened }: {
  chat: AgentChatApi;
  projectFilter: string | null;
  onOpened: () => void;
}) {
  const history = useNativeHistory();
  const { proxies } = useCliProxySettings();
  const { t } = useI18n();
  const [opening, setOpening] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ key: string; detail: string } | null>(null);
  const [reading, setReading] = useState<{ key: string; snapshot: NativeMessageSnapshot } | null>(null);
  const inFlight = useRef(false);
  const known = useMemo(() => new Set(chat.threads.filter(thread => thread.nativeSessionId).map(thread => nativeConversationKey({
    definitionId: thread.definitionId, profileId: thread.accountProfileId ?? null, nativeSessionId: thread.nativeSessionId!,
  }))), [chat.threads]);
  const rows = useMemo(() => (history?.entries ?? []).filter(entry =>
    !entry.archived && !known.has(nativeConversationKey(entry)) &&
    (projectFilter === null || chatProjectKey(entry.workingDirectory) === projectFilter)), [history?.entries, known, projectFilter]);
  if (!history) return null;

  async function open(entry: LocalConversation) {
    if (inFlight.current || !history) return;
    const key = nativeConversationKey(entry);
    if (reading?.key === key) {
      setReading(null);
      return;
    }
    inFlight.current = true;
    setOpening(key);
    setFailed(null);
    try {
      const snapshot = await invoke<NativeMessageSnapshot>("agent_chat_local_history_snapshot", {
        definitionId: entry.definitionId, nativeSessionId: entry.nativeSessionId,
        profileId: entry.profileId, profiles: JSON.parse(history.profileKey),
      });
      // Cursor keeps editor chats that no CLI here can continue, so they are
      // shown in place rather than becoming a thread with a composer.
      if (entry.definitionId === "cursor") {
        setReading({ key, snapshot });
        return;
      }
      const proxy = isProxyConversation(entry) ? nativeConversationProxy(entry, proxies) : undefined;
      chat.importNativeConversation({
        definitionId: entry.definitionId,
        nativeSessionId: entry.nativeSessionId,
        workingDirectory: entry.workingDirectory,
        title: entry.title,
        accountProfileId: entry.profileId,
        messages: snapshot.messages,
        ...(proxy ? { provider: "cliproxyapi" as const, proxyId: proxy.id } : {}),
      });
      onOpened();
    } catch (reason) {
      setFailed({ key, detail: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      inFlight.current = false;
      setOpening(null);
    }
  }

  return <>
    {rows.length > 0 && <ul className="chat-native-rows">
      {rows.map(entry => {
        const key = nativeConversationKey(entry);
        return <li key={key}>
          <button type="button" className="chat-thread" disabled={opening !== null} aria-busy={opening === key}
            aria-expanded={entry.definitionId === "cursor" ? reading?.key === key : undefined}
            title={entry.workingDirectory} onClick={() => void open(entry)}>
            <span>
              <span className="chat-thread__title">{entry.title || t("chat.untitled")}</span>
              <span className="chat-thread__meta">
                {agentDisplayName(entry.definitionId)}
                {entry.profileId ? ` · ${history.profiles.find(profile => profile.id === entry.profileId)?.name ?? entry.profileId}` : ""}
                {entry.workingDirectory ? ` · ${directoryName(entry.workingDirectory)}` : ""}
              </span>
            </span>
          </button>
          {failed?.key === key && <p className="chat-native-rows__error" role="alert">{t("history.stale")} {failed.detail}</p>}
          {reading?.key === key && <div className="chat-native-rows__reader" role="region" aria-label={entry.title || t("chat.untitled")}>
            <p className="chat-native-rows__hint">{t("history.cursorReadOnly")}</p>
            {reading.snapshot.truncated && <p className="chat-native-rows__hint">{t("history.truncated")}</p>}
            {reading.snapshot.messages.map((message, index) =>
              <p key={index} className={`chat-native-rows__message chat-native-rows__message--${message.role}`}>{message.text}</p>)}
          </div>}
        </li>;
      })}
    </ul>}
    {history.error && <p className="chat-threads__hint" role="alert">{t("history.stale")} {history.error}</p>}
    {history.hasMore && <button type="button" className="button button--ghost button--sm" disabled={history.busy} onClick={history.loadMore}>
      {t("history.loadOlder")}
    </button>}
  </>;
}
