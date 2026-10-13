import { describe, expect, it } from "vitest";
import { createThread } from "./agentChat";
import { clearChatProjectDefaults, loadChatProjectDefaults, projectDefaultsUnavailable, saveChatProjectDefaults, type ChatProjectDefaults } from "./chatProjectDefaults";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

const settings: ChatProjectDefaults = {
  definitionId: "codex", model: "test-model", permission: "readOnly", accountProfileId: "account-a",
  effort: "high", browserEnabled: true,
};

describe("project conversation defaults", () => {
  it("applies saved reasoning and browser settings without copying native conversation identity", () => {
    const storage = memoryStorage();
    saveChatProjectDefaults(storage, "/work/a", settings);
    const defaults = loadChatProjectDefaults(storage, "/work/a")!;
    const thread = createThread({ ...defaults, workingDirectory: "/work/a" }, "new-thread", 1);
    expect(thread).toMatchObject({ ...settings, workingDirectory: "/work/a", nativeSessionId: null, items: [] });
  });

  it("retains explicit settings across reloads and isolates projects", () => {
    const storage = memoryStorage();
    expect(loadChatProjectDefaults(storage, "/work/a")).toBeNull();
    saveChatProjectDefaults(storage, "/work/a/", settings);
    saveChatProjectDefaults(storage, "/work/b", { ...settings, model: "other", permission: "ask" });
    expect(loadChatProjectDefaults(storage, "/work/a")).toEqual(settings);
    expect(loadChatProjectDefaults(storage, "/work/b")?.model).toBe("other");
    clearChatProjectDefaults(storage, "/work/a/");
    expect(loadChatProjectDefaults(storage, "/work/a")).toBeNull();
    expect(loadChatProjectDefaults(storage, "/work/b")?.model).toBe("other");
  });

  it("matches Windows verbatim paths and trailing separators", () => {
    const storage = memoryStorage();
    saveChatProjectDefaults(storage, "\\\\?\\D:\\work\\app\\", settings);
    expect(loadChatProjectDefaults(storage, "D:\\work\\app")).toEqual(settings);
  });

  it("stores only settings, never conversation contents, credentials or native identity", () => {
    const storage = memoryStorage();
    saveChatProjectDefaults(storage, "/work/a", { ...settings, nativeSessionId: "private-thread",
      items: ["private-message"], apiKey: "secret", configDirectory: "/private/account" } as ChatProjectDefaults);
    const stored = [...storage.values.values()][0];
    expect(JSON.parse(stored)).toEqual(settings);
    expect(stored).not.toMatch(/private|secret|apiKey|nativeSessionId/);
  });

  it.each([
    { definitionId: "unknown" }, { permission: "unknown" }, { definitionId: "gemini", permission: "ask" },
    { model: 5 }, { accountProfileId: {} }, { browserEnabled: "yes" },
    { provider: "unknown" }, { provider: "cliproxyapi", proxyId: "" }, { effort: 2 },
    { definitionId: "claude", provider: "cliproxyapi", proxyId: "proxy-a" },
  ])("rejects malformed settings without changing the saved value: %j", invalid => {
    const storage = memoryStorage();
    saveChatProjectDefaults(storage, "/work/a", settings);
    expect(() => saveChatProjectDefaults(storage, "/work/a", { ...settings, ...invalid } as ChatProjectDefaults)).toThrow();
    expect(loadChatProjectDefaults(storage, "/work/a")).toEqual(settings);
  });

  it.each(["not-json", "null", '{"definitionId":"codex"}'])("reports corrupt storage rather than silently falling back: %s", raw => {
    expect(() => loadChatProjectDefaults({ getItem: () => raw }, "/work/a")).toThrow();
  });

  it("reports storage failures and allows deleting a corrupt record", () => {
    const storage = memoryStorage();
    saveChatProjectDefaults(storage, "/work/a", settings);
    expect(() => saveChatProjectDefaults({ setItem: () => { throw new Error("quota"); } }, "/work/a", settings)).toThrow("quota");
    expect(loadChatProjectDefaults(storage, "/work/a")).toEqual(settings);
    const key = [...storage.values.keys()][0];
    storage.values.set(key, "bad");
    clearChatProjectDefaults(storage, "/work/a");
    expect(loadChatProjectDefaults(storage, "/work/a")).toBeNull();
    expect(() => loadChatProjectDefaults({ getItem: () => { throw new Error("denied"); } }, "/work/a")).toThrow("denied");
    expect(() => saveChatProjectDefaults(storage, "", settings)).toThrow();
  });

  it("checks the exact assistant and account instead of choosing another", () => {
    expect(projectDefaultsUnavailable(settings, { installed: [], proxies: [], profiles: [] })).toBe("cli");
    expect(projectDefaultsUnavailable(settings, { installed: ["codex"], proxies: [], profiles: [] })).toBe("account");
    expect(projectDefaultsUnavailable(settings, { installed: ["codex"], proxies: [],
      profiles: [{ id: "account-a", definitionId: "claude" }] })).toBe("account");
    expect(projectDefaultsUnavailable(settings, { installed: ["codex"], proxies: [],
      profiles: [{ id: "account-a", definitionId: "codex" }] })).toBeNull();
  });

  it("supports direct proxy conversations without a CLI but rejects a missing proxy", () => {
    const proxySettings: ChatProjectDefaults = { ...settings, provider: "cliproxyapi", proxyId: "proxy-a", accountProfileId: null };
    const storage = memoryStorage();
    saveChatProjectDefaults(storage, "/work/a", proxySettings);
    expect(loadChatProjectDefaults(storage, "/work/a")).toEqual(proxySettings);
    expect(projectDefaultsUnavailable(proxySettings, { installed: [], proxies: [{ id: "other" }], profiles: [] })).toBe("proxy");
    expect(projectDefaultsUnavailable(proxySettings, { installed: [], proxies: [{ id: "proxy-a" }], profiles: [] })).toBeNull();
  });
});
