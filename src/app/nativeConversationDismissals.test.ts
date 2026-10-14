import { afterEach, expect, it, vi } from "vitest";
import { nativeConversationKey, restoreNativeConversation } from "./nativeConversationDismissals";

afterEach(() => vi.unstubAllGlobals());

it("avoids rewriting storage when an unarchived thread was never dismissed", () => {
  const storage = { getItem: vi.fn(() => "[]"), setItem: vi.fn(() => { throw new Error("Synthetic storage full"); }) };
  vi.stubGlobal("localStorage", storage);
  expect(() => restoreNativeConversation({ definitionId: "codex", profileId: null, nativeSessionId: "synthetic-thread" })).not.toThrow();
  expect(storage.setItem).not.toHaveBeenCalled();
});

it("restores only the selected account and preserves other dismissals", () => {
  const entry = { definitionId: "codex", profileId: "synthetic-account", nativeSessionId: "synthetic-thread" };
  const other = nativeConversationKey({ ...entry, profileId: "other-account" });
  const storage = { getItem: vi.fn(() => JSON.stringify([nativeConversationKey(entry), other])), setItem: vi.fn() };
  vi.stubGlobal("localStorage", storage);
  restoreNativeConversation(entry);
  expect(storage.setItem).toHaveBeenCalledWith("latticeterm.nativeConversationDismissed.v1", JSON.stringify([other]));
});
