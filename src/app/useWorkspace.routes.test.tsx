import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { useWorkspace } from "./useWorkspace";
import { createConnectionProfile, emptyDraft } from "../domain/connection";
import { newRouteDraft, savedRouteProfiles } from "./connectionRoutes";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));

it("keeps failed saves out of the workspace and supports reopen, unlink and deletion without replacing other routes", async () => {
  const container = installFakeDom();
  const root = createRoot(container as unknown as Element);
  const source = createConnectionProfile({ ...emptyDraft(), name: "合成主機", hostname: "fixture.invalid" }, "source");
  let database = [source];
  let api!: ReturnType<typeof useWorkspace>;
  function Fixture() { api = useWorkspace(); return null; }
  native.invoke.mockImplementation(async (command: string, args: Record<string, any>) => {
    if (command === "list_connection_profiles") return database;
    if (command === "replace_connection_profiles") database = args.profiles;
    if (command === "save_connection_record") database = savedRouteProfiles(database, args.profile, args.linkedProfileId);
    if (command === "delete_connection_profile") database = database.filter(entry => entry.id !== args.id);
  });
  try {
    await act(async () => root.render(<Fixture />));
    expect(api.profiles).toEqual([source]);
    const route = createConnectionProfile(newRouteDraft(source, [source]), "new-route");
    native.invoke.mockImplementationOnce(async () => { throw new Error("synthetic save failure"); });
    await act(async () => { await expect(api.saveProfileRecord(route, undefined, source.id)).rejects.toThrow("synthetic save failure"); });
    expect(api.profiles).toEqual([source]);
    await act(async () => { await api.saveProfileRecord(route, undefined, source.id); });
    expect(api.profiles).toEqual([{ ...source, machineId: source.id }, route]);
    expect(native.invoke).toHaveBeenCalledWith("save_connection_record", { profile: route, credential: null, linkedProfileId: source.id });
    await act(async () => root.unmount());
    const reopened = createRoot(container as unknown as Element);
    try {
      await act(async () => reopened.render(<Fixture />));
      expect(api.profiles).toEqual(database);
      await act(async () => { expect(await api.unlinkProfile(route.id)).toBeNull(); });
      expect(api.profiles.every(entry => !entry.machineId)).toBe(true);
      await act(async () => { expect(await api.unlinkProfile(route.id)).toBeNull(); });
      await act(async () => { await api.removeProfile(route.id); await api.removeProfile(route.id); });
      expect(api.profiles).toEqual([source]);
      expect(database).toEqual([source]);
    } finally { await act(async () => reopened.unmount()); }
  } finally { await act(async () => root.unmount()); }
});

it("accepts an already-refreshed saved route without losing unrelated records", async () => {
  const container = installFakeDom();
  const root = createRoot(container as unknown as Element);
  const source = createConnectionProfile({ ...emptyDraft(), name: "合成主機", hostname: "fixture.invalid" }, "source");
  const route = createConnectionProfile(newRouteDraft(source, [source]), "route");
  const other = { ...source, id: "other", name: "另一筆連線" };
  let database = [source];
  let finish!: () => void;
  let api!: ReturnType<typeof useWorkspace>;
  function Fixture() { api = useWorkspace(); return null; }
  native.invoke.mockImplementation(async (command: string, args: Record<string, any>) => {
    if (command === "list_connection_profiles") return database;
    if (command === "save_connection_record") {
      database = [...savedRouteProfiles(database, args.profile, args.linkedProfileId), other];
      await new Promise<void>(resolve => { finish = resolve; });
    }
  });
  try {
    await act(async () => root.render(<Fixture />));
    let saving!: Promise<unknown>;
    await act(async () => { saving = api.saveProfileRecord(route, undefined, source.id); });
    await act(async () => api.refreshProfiles());
    await act(async () => { finish(); await saving; });
    expect(api.profiles).toEqual(database);
  } finally { await act(async () => root.unmount()); }
});
