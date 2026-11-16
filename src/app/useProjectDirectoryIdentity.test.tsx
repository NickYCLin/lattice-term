import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { useProjectDirectoryIdentity } from "./useProjectDirectoryIdentity";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./nativeRuntime", () => ({ hasDesktopBackend: () => true }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });
it("merges only backend-confirmed aliases and leaves original launch strings untouched", async () => {
  const paths = ["/home/test/rust", "/data/test/home/rust/", "/other/rust"];
  invoke.mockResolvedValue(paths.map(path => ({ path, canonicalPath: path.includes("/other/") ? null : "/data/test/home/rust" })));
  const root = createRoot(installFakeDom() as unknown as Element);
  let identity!: ReturnType<typeof useProjectDirectoryIdentity>;
  function Probe() { identity = useProjectDirectoryIdentity(paths); return null; }
  try {
    await act(async () => root.render(<Probe />));
    expect(identity.key(paths[0])).toBe(identity.key(paths[1]));
    expect(identity.key(paths[2])).not.toBe(identity.key(paths[0]));
    expect(paths[0]).toBe("/home/test/rust");
    expect(invoke).toHaveBeenCalledWith("project_directory_identities", { paths: [...paths].sort() });
  } finally { await act(async () => root.unmount()); }
});
it("falls back lexically when canonical lookup is unavailable", async () => {
  invoke.mockRejectedValue(new Error("older backend"));
  const root = createRoot(installFakeDom() as unknown as Element);
  let key!: (path: string) => string;
  function Probe() { key = useProjectDirectoryIdentity(["/home/test/rust", "/data/test/home/rust"]).key; return null; }
  try {
    await act(async () => root.render(<Probe />));
    expect(key("/home/test/rust")).not.toBe(key("/data/test/home/rust"));
  } finally { await act(async () => root.unmount()); }
});
