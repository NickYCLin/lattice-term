/**
 * Hosts the chat and automation state at the application root without
 * putting their code in the entry bundle.
 *
 * The hooks must live above the views so replies keep streaming and
 * schedules keep firing while another view is open, but everything they
 * pull in (event folding, Markdown, schedules, folders) is only needed once
 * someone opens a conversation. Loading this component lazily keeps that
 * code out of the first paint; it renders nothing and hands its API up.
 */

import { useDesktopChatHost } from "./useDesktopChatHost";
import { useRemoteChatHost } from "./useRemoteChatHost";
import type { RemoteHostStatus } from "./useRemoteHost";
import { useEffect, useRef } from "react";
import { threadsHeldBySessions } from "./chatSessionHandoff";
import type { AgentSessionSummary } from "./useAgentSessions";
import type { NotificationSoundChoice } from "./notificationSounds";
import { useAgentAutomations, type AgentAutomationsApi } from "./useAgentAutomations";
import { useAgentChat, type AgentChatApi } from "./useAgentChat";

export interface ChatRuntimeApi {
  chat: AgentChatApi;
  automations: AgentAutomationsApi;
}

export function ChatRuntime({
  locale,
  completionSound = "off",
  completionVolume = 60,
  completionNotification = false,
  onChange,
  remoteHost,
  sessions = [],
}: {
  locale: string;
  remoteHost?: RemoteHostStatus | null;
  completionSound?: NotificationSoundChoice;
  completionVolume?: number;
  completionNotification?: boolean;
  onChange: (api: ChatRuntimeApi) => void;
  /** Terminal sessions, so a conversation one of them resumed leaves chat. */
  sessions?: readonly AgentSessionSummary[];
}) {
  const chat = useAgentChat(completionSound, completionVolume, completionNotification);
  useRemoteChatHost(chat, remoteHost ?? null);
  useDesktopChatHost(chat);
  const automations = useAgentAutomations(chat, locale);
  const handingOver = useRef(new Set<string>());
  useEffect(() => {
    for (const id of threadsHeldBySessions(chat.threads, sessions)) {
      if (handingOver.current.has(id)) continue;
      handingOver.current.add(id);
      void chat.continueInSession(id).catch(() => {}).finally(() => handingOver.current.delete(id));
    }
  }, [chat, sessions]);
  useEffect(() => {
    onChange({ chat, automations });
  }, [chat, automations, onChange]);
  return null;
}
