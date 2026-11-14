import { describe, expect, it } from "vitest";
import {
  CHAT_ACCOUNT_PROFILES_KEY,
  loadChatAccountProfiles,
  profileCapable,
  profilesFor,
  saveChatAccountProfiles,
} from "./chatAccountProfiles";

function storage(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe("chat account profiles", () => {
  it("keeps only safe, distinct local profile metadata", () => {
    const store = storage({
      [CHAT_ACCOUNT_PROFILES_KEY]: JSON.stringify([
        { id: "personal", definitionId: "codex", name: "個人", configDirectory: "/profiles/personal" },
        { id: "personal", definitionId: "claude", name: "duplicate", configDirectory: "/x" },
        { id: "key", definitionId: "gemini", name: "bad", configDirectory: "/x" },
        { id: "secret", definitionId: "codex", name: "", configDirectory: "/x" },
        { id: "flag", definitionId: "codex", name: "bad flag", configDirectory: "/x", managed: "yes" },
        { id: "managed", definitionId: "codex", name: "自建", configDirectory: "/x", managed: true },
      ]),
    });
    expect(loadChatAccountProfiles(store)).toEqual([
      { id: "personal", definitionId: "codex", name: "個人", configDirectory: "/profiles/personal" },
      { id: "managed", definitionId: "codex", name: "自建", configDirectory: "/x", managed: true },
    ]);
  });

  it("persists no credential material and filters by CLI", () => {
    const store = storage();
    const profiles = [
      { id: "personal", definitionId: "codex" as const, name: "個人", configDirectory: "/profiles/personal" },
      { id: "company", definitionId: "claude" as const, name: "公司", configDirectory: "/profiles/company" },
    ];
    saveChatAccountProfiles(store, profiles);
    expect(loadChatAccountProfiles(store)).toEqual(profiles);
    expect(profilesFor(profiles, "codex")).toEqual([profiles[0]]);
    expect(profilesFor(profiles, "gemini")).toEqual([]);
    expect(profileCapable("claude")).toBe(true);
    expect(profileCapable("gemini")).toBe(false);
  });

  it("rejects overflow without silently truncating or changing the saved list", () => {
    const profiles = Array.from({ length: 24 }, (_, index) => ({
      id: "account-" + index, definitionId: "codex" as const, name: "Account " + index, configDirectory: "/profiles/" + index,
    }));
    const store = storage();
    saveChatAccountProfiles(store, profiles);
    expect(() => saveChatAccountProfiles(store, [...profiles, { ...profiles[0], id: "overflow" }])).toThrow();
    expect(loadChatAccountProfiles(store)).toEqual(profiles);
  });
});
