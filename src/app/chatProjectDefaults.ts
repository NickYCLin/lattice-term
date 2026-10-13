import { permissionsFor, type ChatDefinitionId, type ChatThread } from "./agentChat";
import { chatProjectKey } from "./chatProjects";

export type ChatProjectDefaults = Pick<ChatThread,
  "definitionId" | "model" | "permission" | "accountProfileId" | "provider" | "proxyId" | "effort" | "browserEnabled">;

function storageKey(directory: string): string {
  const project = chatProjectKey(directory);
  if (!project) throw new Error("A project folder is required.");
  return `latticeterm.chatProjectDefaults.v1:${encodeURIComponent(project)}`;
}

function parseDefaults(value: unknown): ChatProjectDefaults {
  if (!value || typeof value !== "object") throw new Error("Invalid project defaults.");
  const record = value as Record<string, unknown>;
  const definitionId = record.definitionId as ChatDefinitionId;
  const boundedText = (text: unknown) => typeof text === "string" && text.length <= 4096;
  if (!["codex", "claude", "gemini", "antigravity"].includes(definitionId)
    || !permissionsFor(definitionId).includes(record.permission as ChatThread["permission"])
    || !boundedText(record.model)
    || !(record.accountProfileId === null || boundedText(record.accountProfileId))
    || !(record.provider === undefined || record.provider === "cliproxyapi")
    || !(record.proxyId === undefined || boundedText(record.proxyId))
    || !(record.effort === undefined || record.effort === null || boundedText(record.effort))
    || !(record.browserEnabled === undefined || typeof record.browserEnabled === "boolean")
    || (record.provider === "cliproxyapi" && (!record.proxyId || definitionId !== "codex"))) {
    throw new Error("Invalid project defaults.");
  }
  return {
    definitionId, model: record.model as string, permission: record.permission as ChatThread["permission"],
    accountProfileId: record.accountProfileId as string | null,
    provider: record.provider as "cliproxyapi" | undefined, proxyId: record.proxyId as string | undefined,
    effort: record.effort as string | null | undefined, browserEnabled: record.browserEnabled as boolean | undefined,
  };
}

export function loadChatProjectDefaults(storage: Pick<Storage, "getItem">, directory: string): ChatProjectDefaults | null {
  const raw = storage.getItem(storageKey(directory));
  return raw === null ? null : parseDefaults(JSON.parse(raw));
}

export function saveChatProjectDefaults(storage: Pick<Storage, "setItem">, directory: string, settings: ChatProjectDefaults): ChatProjectDefaults {
  const defaults = parseDefaults(settings);
  storage.setItem(storageKey(directory), JSON.stringify(defaults));
  return defaults;
}

export function clearChatProjectDefaults(storage: Pick<Storage, "removeItem">, directory: string): void {
  storage.removeItem(storageKey(directory));
}

export function projectDefaultsUnavailable(defaults: ChatProjectDefaults, sources: {
  installed: readonly ChatDefinitionId[];
  proxies: readonly { id: string }[];
  profiles: readonly { id: string; definitionId: string }[];
}): "cli" | "proxy" | "account" | null {
  if (defaults.provider === "cliproxyapi") {
    if (!sources.proxies.some(proxy => proxy.id === defaults.proxyId)) return "proxy";
  } else if (!sources.installed.includes(defaults.definitionId)) return "cli";
  if (defaults.accountProfileId && !sources.profiles.some(profile =>
    profile.id === defaults.accountProfileId && profile.definitionId === defaults.definitionId)) return "account";
  return null;
}
