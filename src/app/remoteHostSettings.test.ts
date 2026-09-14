import { expect, it } from "vitest";
import { loadRemoteHostSettings, saveRemoteHostSettings } from "./remoteHostSettings";

it("does not persist or restore Fleet authority with a saved pairing password", () => {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() { return values.size; },
    clear: () => values.clear(), key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
  const defaults = loadRemoteHostSettings(storage);
  saveRemoteHostSettings(storage, { ...defaults, mode: "relay", useSavedPairingCode: true, fleet: { directory: "/fixture/project", read: true, control: true, launch: true } });
  expect([...values.values()].join("")).not.toContain("fleet");
  expect([...values.values()].join("")).not.toContain("/fixture/project");
  expect(loadRemoteHostSettings(storage).fleet).toBeUndefined();
  expect(loadRemoteHostSettings(storage).useSavedPairingCode).toBe(true);
  storage.setItem("latticeterm.remote.hostSettings.v1", JSON.stringify({ ...defaults, fleet: { directory: "/fixture/project", control: true } }));
  expect(loadRemoteHostSettings(storage).fleet).toBeUndefined();
});
