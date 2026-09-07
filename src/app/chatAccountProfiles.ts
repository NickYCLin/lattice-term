/**
 * Named, local CLI configuration roots.  A profile is only a label and a
 * directory managed by LatticeTerm (or selected in older versions). The
 * profile metadata never contains a token, email, or a CLI's auth file.
 */
import type { ChatDefinitionId } from "./agentChat";

export type ProfiledChatDefinitionId = Exclude<ChatDefinitionId, "gemini">;

export interface ChatAccountProfile {
  id: string;
  definitionId: ProfiledChatDefinitionId;
  name: string;
  configDirectory: string;
  /** True when LatticeTerm created the directory and may delete it again. */
  managed?: boolean;
}

export const CHAT_ACCOUNT_PROFILES_KEY = "latticeterm.chatAccountProfiles.v1";
const MAX_PROFILES = 24;
const MAX_NAME_LENGTH = 64;

export function profileCapable(definitionId: string): definitionId is ProfiledChatDefinitionId {
  return definitionId === "codex" || definitionId === "claude";
}

function isProfile(value: unknown): value is ChatAccountProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Partial<ChatAccountProfile>;
  return (
    typeof profile.id === "string" &&
    profile.id.length > 0 &&
    profile.id.length <= 64 &&
    (profile.definitionId === "codex" || profile.definitionId === "claude") &&
    typeof profile.name === "string" &&
    profile.name.trim().length > 0 &&
    profile.name.length <= MAX_NAME_LENGTH &&
    typeof profile.configDirectory === "string" &&
    profile.configDirectory.trim().length > 0 &&
    (profile.managed === undefined || typeof profile.managed === "boolean")
  );
}

export function loadChatAccountProfiles(
  storage: Pick<Storage, "getItem">,
): ChatAccountProfile[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(CHAT_ACCOUNT_PROFILES_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    const ids = new Set<string>();
    return value.filter(isProfile).filter((profile) => {
      if (ids.has(profile.id)) return false;
      ids.add(profile.id);
      return true;
    }).slice(0, MAX_PROFILES);
  } catch {
    return [];
  }
}

export function saveChatAccountProfiles(
  storage: Pick<Storage, "setItem" | "removeItem">,
  profiles: readonly ChatAccountProfile[],
): void {
  const valid = profiles.filter(isProfile).slice(0, MAX_PROFILES);
  if (valid.length === 0) storage.removeItem(CHAT_ACCOUNT_PROFILES_KEY);
  else storage.setItem(CHAT_ACCOUNT_PROFILES_KEY, JSON.stringify(valid));
}

export function profilesFor(
  profiles: readonly ChatAccountProfile[],
  definitionId: string,
): readonly ChatAccountProfile[] {
  return profileCapable(definitionId)
    ? profiles.filter((profile) => profile.definitionId === definitionId)
    : [];
}
