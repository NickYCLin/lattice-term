import { describe, expect, it, vi } from "vitest";
import { planReleasePruning, pruneReleases } from "./prune-releases.mjs";

const release = (id, extra = {}) => ({
  id, tag_name: `v2.${id}.0`, draft: false, prerelease: false,
  published_at: `2026-09-${String(id).padStart(2, "0")}T00:00:00Z`,
  updated_at: "2026-09-18T00:00:00Z", assets: [], ...extra,
});

function fixture() {
  const releases = [1, 2, 3, 4, 5].map((id) => release(id));
  const latest = releases[4];
  const manifest = { version: "2.5.0", platforms: {} };
  for (const [targets, suffix] of [
    [["darwin-x86_64", "darwin-x86_64-app"], "_x64.app.tar.gz"],
    [["darwin-aarch64", "darwin-aarch64-app"], "_aarch64.app.tar.gz"],
    [["linux-x86_64"], "_amd64.AppImage"],
    [["linux-aarch64"], "_aarch64.AppImage"],
    [["windows-x86_64"], "_x64-setup.exe"],
  ]) {
    const name = `LatticeTerm_2.5.0${suffix}`;
    const url = `https://github.com/example/app/releases/download/v2.5.0/${name}`;
    latest.assets.push({ name, browser_download_url: url, state: "uploaded", size: 100 }, { name: `${name}.sig`, state: "uploaded", size: 10 });
    for (const target of targets) manifest.platforms[target] = { url, signature: "signed" };
  }
  const repos = {
    listReleases: vi.fn(),
    getLatestRelease: vi.fn(async () => ({ data: latest })),
    getRelease: vi.fn(async ({ release_id }) => ({ data: releases.find((entry) => entry.id === release_id) })),
    deleteRelease: vi.fn(),
  };
  return {
    github: { rest: { repos }, paginate: vi.fn(async () => releases) },
    context: { repo: { owner: "example", repo: "app" } }, core: { info: vi.fn() },
    expectedTag: "v2.5.0", fetchManifest: vi.fn(async () => manifest),
    releases, manifest, repos,
  };
}

describe("stable download retention", () => {
  it("keeps three published releases and excludes drafts, prereleases and other tags", () => {
    const plan = planReleasePruning([
      release(2), release(5), release(1), release(4), release(3),
      release(6, { draft: true }), release(7, { prerelease: true }), release(8, { tag_name: "nightly" }),
    ], "v2.5.0");
    expect(plan.keep.map((entry) => entry.id)).toEqual([5, 4, 3]);
    expect(plan.remove.map((entry) => entry.id)).toEqual([2, 1]);
    expect(planReleasePruning([release(5)], "v2.5.0").remove).toEqual([]);
  });
  it("rejects missing history, bad dates and an unexpected newest release", () => {
    expect(() => planReleasePruning([], "v2.5.0")).toThrow();
    expect(() => planReleasePruning([release(5, { published_at: null })], "v2.5.0")).toThrow();
    expect(() => planReleasePruning([release(6)], "v2.5.0")).toThrow();
  });
  it("validates the public updater before deleting only the planned release IDs", async () => {
    const f = fixture();
    await pruneReleases(f);
    expect(f.fetchManifest).toHaveBeenCalledWith("https://github.com/example/app/releases/latest/download/latest.json");
    expect(f.repos.deleteRelease.mock.calls.map(([args]) => args.release_id)).toEqual([2, 1]);
    expect(f.repos.getLatestRelease).toHaveBeenCalledTimes(3);
  });
  it.each(["missing-platform", "wrong-version", "unavailable"])("deletes nothing when the updater is %s", async (fault) => {
    const f = fixture();
    if (fault === "missing-platform") delete f.manifest.platforms["darwin-x86_64"];
    if (fault === "wrong-version") f.manifest.version = "2.4.0";
    if (fault === "unavailable") f.fetchManifest.mockRejectedValue(new Error("404"));
    await expect(pruneReleases(f)).rejects.toThrow();
    expect(f.repos.deleteRelease).not.toHaveBeenCalled();
  });
  it("stops if another publication changes latest after planning", async () => {
    const f = fixture();
    f.repos.getLatestRelease.mockResolvedValueOnce({ data: f.releases[4] }).mockResolvedValue({ data: release(6) });
    await expect(pruneReleases(f)).rejects.toThrow(/latest/);
    expect(f.repos.deleteRelease).not.toHaveBeenCalled();
  });
  it.each([{ draft: true }, { tag_name: "v9.0.0" }, { updated_at: "changed" }])("preserves a release modified after planning: %j", async (change) => {
    const f = fixture(); f.repos.getRelease.mockResolvedValue({ data: release(2, change) });
    await expect(pruneReleases(f)).rejects.toThrow(/已變動/);
    expect(f.repos.deleteRelease).not.toHaveBeenCalled();
  });
});
