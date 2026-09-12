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

import { useRemoteChatHost } from "./useRemoteChatHost";
import type { RemoteHostStatus } from "./useRemoteHost";
import { useEffect } from "react";
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
  onChange,
  remoteHost,
}: {
  locale: string;
  remoteHost?: RemoteHostStatus | null;
  completionSound?: NotificationSoundChoice;
  onChange: (api: ChatRuntimeApi) => void;
}) {
  const chat = useAgentChat(completionSound);
  useRemoteChatHost(chat, remoteHost ?? null);
  const automations = useAgentAutomations(chat, locale);
  useEffect(() => {
    onChange({ chat, automations });
  }, [chat, automations, onChange]);
  return null;
}
