import { permissionsFor, type ChatDefinitionId, type ChatThread } from "./agentChat";
import { chatProjectKey } from "./chatProjects";
import { displayPath } from "./displayPath";

export type ChatProjectDefaults = Pick<ChatThread,
  "definitionId" | "model" | "permission" | "accountProfileId" | "provider" | "proxyId" | "effort" | "browserEnabled">;

const legacyPrefix = "latticeterm.chatProjectDefaults.v1:";
function storageKey(directory: string): string {
  const project = chatProjectKey(directory);
  if (!project) throw new Error("A project folder is required.");
  const prefix = /^[a-z]:\//i.test(project) || project.startsWith("//")
    ? "latticeterm.chatProjectDefaults.v2:" : legacyPrefix;
  return prefix + encodeURIComponent(project);
}

export class ChatProjectDefaultsConflict extends Error {
  constructor() { super("Conflicting project defaults; save or clear this project's defaults explicitly."); }
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

export function loadChatProjectDefaults(storage: Pick<Storage, "getItem"> & Partial<Pick<Storage, "length" | "key">>, directory: string): ChatProjectDefaults | null {
  const currentKey = storageKey(directory);
  const raw = storage.getItem(currentKey);
  if (raw !== null) {
    if (!currentKey.startsWith(legacyPrefix) && raw === "null") return null;
    return parseDefaults(JSON.parse(raw));
  }
  if (currentKey.startsWith(legacyPrefix)) return null;
  const plain = displayPath(directory.trim());
  const oldDirectory = plain.replace(/[\\/]+$/, "") || plain;
  if (/^[a-z]:[\\/]+$/i.test(plain) && storage.getItem(legacyPrefix + encodeURIComponent(oldDirectory)) !== null) {
    throw new ChatProjectDefaultsConflict();
  }
  const candidates = new Set<string>();
  if (chatProjectKey(oldDirectory) === chatProjectKey(directory)) candidates.add(legacyPrefix + encodeURIComponent(oldDirectory));
  if (storage.key && storage.length !== undefined) {
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (!key?.startsWith(legacyPrefix)) continue;
      let path: string;
      try { path = decodeURIComponent(key.slice(legacyPrefix.length)); } catch { continue; }
      if (/^[a-z]:[\\/]+$/i.test(plain) && path.toLowerCase() === plain.slice(0, 2).toLowerCase()) {
        throw new ChatProjectDefaultsConflict();
      }
      if (chatProjectKey(path) === chatProjectKey(directory)) candidates.add(key);
    }
  }
  let found: ChatProjectDefaults | null = null;
  for (const key of candidates) {
    const value = storage.getItem(key);
    if (value === null) continue;
    const defaults = parseDefaults(JSON.parse(value));
    if (found && JSON.stringify(found) !== JSON.stringify(defaults)) throw new ChatProjectDefaultsConflict();
    found = defaults;
  }
  return found;
}

export function saveChatProjectDefaults(storage: Pick<Storage, "setItem">, directory: string, settings: ChatProjectDefaults): ChatProjectDefaults {
  const defaults = parseDefaults(settings);
  storage.setItem(storageKey(directory), JSON.stringify(defaults));
  return defaults;
}

export function clearChatProjectDefaults(storage: Pick<Storage, "removeItem"> & Partial<Pick<Storage, "setItem">>, directory: string): void {
  const key = storageKey(directory);
  if (key.startsWith(legacyPrefix)) storage.removeItem(key);
  else {
    if (!storage.setItem) throw new Error("Cannot clear project defaults without persistent storage.");
    storage.setItem(key, "null");
  }
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
