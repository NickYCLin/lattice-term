import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { useWorkspace } from "./useWorkspace";
import { createConnectionProfile, emptyDraft, type ConnectionProfile } from "../domain/connection";
import { parseAndValidateImport, planProfileImport } from "../domain/export";
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
beforeEach(() => { native.invoke.mockReset(); });
const profile = createConnectionProfile({ ...emptyDraft("ssh"), name: "Fixture", hostname: "host.invalid", username: "fixture" }, "local-id");

it("overwrites metadata once, retains local credential identities and reports unique add/overwrite counts", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let records = [profile];
  const credentials = new Map([[profile.id, { opaqueHandle: "synthetic-credential-reference" }]]);
  let api!: ReturnType<typeof useWorkspace>;
  function Fixture() { api = useWorkspace(); return null; }
  native.invoke.mockImplementation(async (command: string, args: { profiles?: ConnectionProfile[] }) => {
    if (command === "list_connection_profiles") return records;
    if (command === "replace_connection_profiles") records = args.profiles!;
  });
  try {
    await act(async () => root.render(<Fixture />));
    const imported = parseAndValidateImport(JSON.stringify([{ ...profile, name: "Renamed", password: "test-only-excluded", privateKey: "test-only-excluded" }, { ...profile, id: undefined, name: "Last row" }])).validProfiles;
    const plan = planProfileImport(api.profiles, imported);
    native.invoke.mockClear();
    await act(async () => {
      expect(await api.importProfiles(plan)).toEqual({ count: 1, addedCount: 0, overwrittenCount: 1, error: null });
    });
    expect(records).toHaveLength(1); expect(records[0]).toMatchObject({ id: profile.id, name: "Last row" });
    expect(api.profiles).toEqual(records);
    expect(credentials.get(profile.id)).toEqual({ opaqueHandle: "synthetic-credential-reference" });
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("replace_connection_profiles", { profiles: plan.next, expectedProfiles: plan.original });
    expect(JSON.stringify(native.invoke.mock.calls)).not.toContain("test-only-excluded");
    expect(api.activity.filter(entry => entry.kind === "updated")).toHaveLength(1);
    await act(async () => {
      const repeat = planProfileImport(api.profiles, imported);
      expect((await api.importProfiles(repeat)).addedCount).toBe(0);
    });
    expect(records).toHaveLength(1);
  } finally { await act(async () => root.unmount()); }
});

it("rejects stale previews and same-turn duplicate confirmations without appending or overwriting", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let api!: ReturnType<typeof useWorkspace>;
  function Fixture() { api = useWorkspace(); return null; }
  let finish!: () => void;
  native.invoke.mockImplementation(async command => command === "list_connection_profiles" ? [profile] : new Promise<void>(done => { finish = done; }));
  try {
    await act(async () => root.render(<Fixture />));
    const plan = planProfileImport(api.profiles, [{ ...profile, name: "Reviewed" }]);
    let pending!: ReturnType<typeof api.importProfiles>;
    await act(async () => {
      pending = api.importProfiles(plan);
      expect((await api.importProfiles(plan)).error).toBe("transfer.import.busy");
    });
    await act(async () => { finish(); await pending; });
    const writes = native.invoke.mock.calls.filter(([command]) => command === "replace_connection_profiles");
    expect(writes).toHaveLength(1);
    await act(async () => { expect((await api.importProfiles(plan)).error).toBe("transfer.import.changed"); });
    expect(api.profiles[0].name).toBe("Reviewed");
  } finally { await act(async () => root.unmount()); }
});

it("keeps current metadata and activity counts when persistence fails", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let api!: ReturnType<typeof useWorkspace>;
  function Fixture() { api = useWorkspace(); return null; }
  native.invoke.mockImplementation(async command => {
    if (command === "list_connection_profiles") return [profile];
    throw new Error("synthetic write failure");
  });
  try {
    await act(async () => root.render(<Fixture />));
    await act(async () => {
      const result = await api.importProfiles(planProfileImport(api.profiles, [{ ...profile, name: "Not saved" }]));
      expect(result).toMatchObject({ count: 0, addedCount: 0, overwrittenCount: 0, error: "synthetic write failure" });
    });
    expect(api.profiles).toEqual([profile]);
    expect(api.activity.some(entry => entry.kind === "updated" || entry.kind === "created")).toBe(false);
  } finally { await act(async () => root.unmount()); }
});
