import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { useWorkspace } from "./useWorkspace";
import { createConnectionProfile, emptyDraft, type ConnectionProfile } from "../domain/connection";
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
afterEach(() => { vi.unstubAllGlobals(); native.invoke.mockReset(); });
it("merges only after confirmation and restores without deleting profiles or touching credentials", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  const base = createConnectionProfile({ ...emptyDraft("ssh"), name: "合成目標", hostname: "target.invalid", username: "fixture" }, "target");
  let records = [base, { ...base, id: "legacy", name: "合成目標（經跳板）", hostname: "127.0.0.1" }, { ...base, id: "gateway", name: "跳板", hostname: "gateway.invalid" }];
  const original = records;
  let api!: ReturnType<typeof useWorkspace>;
  function Fixture() { api = useWorkspace(); return null; }
  native.invoke.mockImplementation(async (command: string, args: { profiles?: ConnectionProfile[] }) => {
    if (command === "list_connection_profiles") return records;
    if (command === "replace_connection_profiles") records = args.profiles!;
  });
  try {
    await act(async () => root.render(<Fixture />)); native.invoke.mockClear();
    expect(records).toEqual(original); expect(native.invoke).not.toHaveBeenCalled();
    await act(async () => { expect(await api.migrateJumpProfile("legacy", "target", "gateway")).toBeNull(); });
    expect(records.map(entry => entry.id)).toEqual(original.map(entry => entry.id));
    expect(records[0].jumpProfileId).toBe("gateway"); expect(records[1].retiredTo).toBe("target");
    expect(api.visibleProfiles.map(entry => entry.id).sort()).toEqual(["gateway", "target"]);
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("replace_connection_profiles", { profiles: records, expectedProfiles: original });
    native.invoke.mockClear();
    await act(async () => { expect(await api.migrateJumpProfile("legacy")).toBeNull(); });
    expect(records[1].retiredTo).toBeUndefined(); expect(records).toHaveLength(3);
    expect(api.visibleProfiles).toHaveLength(3);
    expect(native.invoke.mock.calls.map(([name]) => name)).toEqual(["replace_connection_profiles"]);
    native.invoke.mockClear();
    await act(async () => { expect(await api.migrateJumpProfile("legacy", "target")).not.toBeNull(); });
    expect(native.invoke).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});
