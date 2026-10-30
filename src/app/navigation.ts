/**
 * Primary navigation registry.
 *
 * `status` is what the interface promises: `available` areas do real work,
 * `planned` areas describe what is coming and never show a control that
 * pretends to act.
 */

import {
  AgentIcon,
  BellIcon,
  ChatIcon,
  ConnectionsIcon,
  SettingsIcon,
  TerminalIcon,
  TunnelIcon,
  VaultIcon,
  type IconProps,
} from "../components/icons";
import type { MessageKey } from "../i18n/messages/zh-TW";
import type { ReactElement } from "react";

export type ViewId =
  | "connections"
  | "agents"
  | "chat"
  | "terminal"
  | "tunnels"
  | "vault"
  | "activity"
  | "settings";

export interface NavigationItem {
  id: ViewId;
  labelKey: MessageKey;
  descriptionKey: MessageKey;
  icon: (props: IconProps) => ReactElement;
  status: "available" | "planned";
  /** Areas built on local processes (CLI PTYs, sidecar engines) that a
   *  mobile OS cannot run. Hidden there rather than shown broken. */
  desktopOnly?: boolean;
}

export const navigationItems: NavigationItem[] = [
  {
    id: "connections",
    labelKey: "nav.connections",
    descriptionKey: "nav.connections.desc",
    icon: ConnectionsIcon,
    status: "available",
  },
  {
    id: "terminal",
    labelKey: "terminal.title",
    descriptionKey: "terminal.desc",
    icon: TerminalIcon,
    status: "available",
  },
  {
    id: "agents",
    labelKey: "nav.agents",
    descriptionKey: "nav.agents.desc",
    icon: AgentIcon,
    status: "available",
    desktopOnly: true,
  },
  {
    id: "chat",
    labelKey: "nav.chat",
    descriptionKey: "nav.chat.desc",
    icon: ChatIcon,
    status: "available",
    desktopOnly: true,
  },
  {
    id: "tunnels",
    labelKey: "nav.tunnels",
    descriptionKey: "nav.tunnels.desc",
    icon: TunnelIcon,
    status: "available",
  },
  {
    id: "vault",
    labelKey: "nav.vault",
    descriptionKey: "nav.vault.desc",
    icon: VaultIcon,
    status: "available",
  },
  {
    id: "activity",
    labelKey: "nav.activity",
    descriptionKey: "nav.activity.desc",
    icon: BellIcon,
    status: "available",
  },
  {
    id: "settings",
    labelKey: "nav.settings",
    descriptionKey: "nav.settings.desc",
    icon: SettingsIcon,
    status: "available",
  },
];

export function findNavigationItem(id: ViewId): NavigationItem {
  return navigationItems.find((item) => item.id === id)!;
}

export function isMobilePlatform(platform: string | undefined): boolean {
  return platform === "android" || platform === "ios";
}

/** The navigation a given platform actually offers. */
export function navigationItemsFor(platform: string | undefined): NavigationItem[] {
  if (!isMobilePlatform(platform)) return navigationItems;
  return navigationItems.flatMap((item) => item.id === "agents"
    ? [{ ...item, desktopOnly: false, labelKey: "agents.remoteFleet.title" as const, descriptionKey: "agents.remoteFleet.mobileBody" as const }]
    : item.desktopOnly ? [] : [item]);
}
