import { describe, expect, it } from "vitest";
import { defaultPreferences } from "./preferences";
import {
  applyRestoredLocalStorage,
  backupPasswordIsValid,
  collectBackupLocalStorage,
  encryptedBackupFilename,
  type BackupStorageAdapter,
} from "./encryptedBackup";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const adapter: BackupStorageAdapter = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
  return { adapter, values };
}

describe("encrypted backup local storage", () => {
  it("collects only LatticeTerm allowlisted data and current preferences", () => {
    const storage = memoryStorage({
      "latticeterm.tunnels.v1": "[]",
      "unrelated.site.token": '"must not leave"',
    });

    const collected = collectBackupLocalStorage(
      storage.adapter,
      defaultPreferences,
    );

    expect(JSON.parse(collected["latticeterm.preferences.v2"])).toEqual(
      defaultPreferences,
    );
    expect(collected["latticeterm.tunnels.v1"]).toBe("[]");
    expect(collected).not.toHaveProperty("unrelated.site.token");
  });

  it("restores an exact snapshot and removes allowlisted leftovers", () => {
    const storage = memoryStorage({
      "latticeterm.tunnels.v1": '[{"id":"old"}]',
      "latticeterm.authPrefs.v1": '{"old":true}',
      "unrelated.site.token": '"keep"',
    });
    const restoredPreferences = {
      ...defaultPreferences,
      theme: "light" as const,
    };

    const preferences = applyRestoredLocalStorage(storage.adapter, {
      "latticeterm.preferences.v2": JSON.stringify(restoredPreferences),
      "latticeterm.tunnels.v1": "[]",
    });

    expect(preferences.theme).toBe("light");
    expect(storage.values.get("latticeterm.tunnels.v1")).toBe("[]");
    expect(storage.values.has("latticeterm.authPrefs.v1")).toBe(false);
    expect(storage.values.get("unrelated.site.token")).toBe('"keep"');
  });

  it("carries scheduled chats in both directions", () => {
    const schedules = '[{"id":"daily-report"}]';
    const source = memoryStorage({ "latticeterm.agentAutomations.v1": schedules });
    const collected = collectBackupLocalStorage(source.adapter, defaultPreferences);
    expect(collected["latticeterm.agentAutomations.v1"]).toBe(schedules);

    const target = memoryStorage({ "latticeterm.agentAutomations.v1": "[]" });
    applyRestoredLocalStorage(target.adapter, collected);
    expect(target.values.get("latticeterm.agentAutomations.v1")).toBe(schedules);
  });

  it("keeps this machine's schedules when an older backup has none", () => {
    const storage = memoryStorage({
      "latticeterm.agentAutomations.v1": '[{"id":"mine"}]',
    });
    applyRestoredLocalStorage(storage.adapter, {
      "latticeterm.preferences.v2": JSON.stringify(defaultPreferences),
    });
    expect(storage.values.get("latticeterm.agentAutomations.v1")).toBe('[{"id":"mine"}]');
  });

  it("refuses backend responses containing non-allowlisted keys", () => {
    const storage = memoryStorage();
    expect(() =>
      applyRestoredLocalStorage(storage.adapter, {
        "unrelated.site.token": '"unexpected"',
      }),
    ).toThrow("unsupported local setting");
  });

  it("rolls back local settings when a WebView write fails", () => {
    const storage = memoryStorage({
      "latticeterm.preferences.v2": '{"theme":"dark"}',
      "latticeterm.tunnels.v1": '[{"id":"current"}]',
    });
    let writes = 0;
    const failing: BackupStorageAdapter = {
      ...storage.adapter,
      setItem: (key, value) => {
        writes += 1;
        if (writes == 2) throw new Error("quota");
        storage.adapter.setItem(key, value);
      },
    };

    expect(() =>
      applyRestoredLocalStorage(failing, {
        "latticeterm.preferences.v2": '{"theme":"light"}',
        "latticeterm.tunnels.v1": "[]",
      }),
    ).toThrow("quota");
    expect(storage.values.get("latticeterm.preferences.v2")).toBe(
      '{"theme":"dark"}',
    );
    expect(storage.values.get("latticeterm.tunnels.v1")).toBe(
      '[{"id":"current"}]',
    );
  });
});

describe("backupPasswordIsValid", () => {
  it("counts Unicode characters the same way as the Rust backend", () => {
    expect(backupPasswordIsValid("😀".repeat(6))).toBe(false);
    expect(backupPasswordIsValid("😀".repeat(12))).toBe(true);
    expect(backupPasswordIsValid("a".repeat(1025))).toBe(false);
  });
});

describe("encryptedBackupFilename", () => {
  it("uses the dedicated portable backup extension", () => {
    expect(encryptedBackupFilename(0)).toBe(
      "LatticeTerm-1970-01-01T00-00-00-000Z.latticeterm-backup",
    );
  });
});
