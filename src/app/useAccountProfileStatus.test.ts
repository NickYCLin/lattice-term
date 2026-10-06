import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import {
  accountProfileIdentity,
  accountProfileOptionKey,
  readAccountProfileStatuses,
} from "./useAccountProfileStatus";

const profiles = [
  { id: "work", definitionId: "codex" as const, name: "公司", configDirectory: "/p/work", managed: true },
  { id: "home", definitionId: "claude" as const, name: "個人", configDirectory: "/p/home" },
];

describe("account profile status", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    invoke.mockReset();
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("asks the backend about each profile's own directory and survives one failing", async () => {
    invoke.mockImplementation(async (_command: string, args: { definitionId: string }) => {
      if (args.definitionId === "claude") throw new Error("unreadable");
      return { state: "signedIn", label: "me@example.com", method: "ChatGPT" };
    });
    const statuses = await readAccountProfileStatuses(profiles, [
      { id: "team", baseUrl: "http://10.0.0.5:8317" },
    ]);
    expect(invoke).toHaveBeenCalledWith("agent_account_profile_status", {
      definitionId: "codex",
      configDirectory: "/p/work",
      proxies: [{ id: "team", baseUrl: "http://10.0.0.5:8317" }],
    });
    expect(statuses.work).toEqual({ state: "signedIn", label: "me@example.com", method: "ChatGPT" });
    expect(statuses.home.state).toBe("unknown");
  });

  it("does nothing outside the desktop app or without profiles", async () => {
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
    expect(await readAccountProfileStatuses(profiles)).toEqual({});
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    expect(await readAccountProfileStatuses([])).toEqual({});
    expect(invoke).not.toHaveBeenCalled();
  });

  it("labels an option by its login state", () => {
    expect(accountProfileOptionKey(undefined)).toBe("agents.account.option.unknown");
    expect(accountProfileOptionKey({ state: "signedOut", label: null, method: null })).toBe(
      "agents.account.option.signedOut",
    );
    expect(accountProfileOptionKey({ state: "signedIn", label: null, method: "OpenAI API Key" })).toBe(
      "agents.account.option.signedInLabeled",
    );
    expect(accountProfileIdentity({ state: "signedIn", label: null, method: "OpenAI API Key" })).toBe(
      "OpenAI API Key",
    );
    expect(accountProfileOptionKey({ state: "signedIn", label: null, method: null })).toBe(
      "agents.account.option.signedIn",
    );
    expect(
      accountProfileOptionKey({ state: "signedIn", label: "me@example.com", method: "ChatGPT" }),
    ).toBe("agents.account.option.signedInLabeled");
  });
});
