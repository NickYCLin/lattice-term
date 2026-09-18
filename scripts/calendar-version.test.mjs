import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { calendarVersion, availableCalendarVersion } from "./calendar-version.mjs";
import { calendarManifest } from "./create-calendar-release-pr.mjs";

const require = createRequire(import.meta.url);
const { buildStrategy } = require("release-please/build/src/factory");
const { TagName } = require("release-please/build/src/util/tag-name");
const { Version } = require("release-please/build/src/version");
const { parseConventionalCommits } = require("release-please/build/src/commit");

describe("Taipei date versions", () => {
  it.each([
    ["2026-09-18T02:17:00Z", "2026.9.18"],
    ["2026-09-18T16:00:00Z", "2026.9.19"],
    ["2026-09-30T16:00:00Z", "2026.10.1"],
    ["2026-12-31T16:00:00Z", "2027.1.1"],
    ["2028-02-29T02:17:00Z", "2028.2.29"],
  ])("converts %s to %s", (date, version) => {
    expect(calendarVersion(new Date(date))).toBe(version);
    expect(Version.parse(version).toString()).toBe(version);
  });
  it("rejects invalid dates and never reuses an existing tag", () => {
    expect(() => calendarVersion(new Date(NaN))).toThrow();
    const date = new Date("2026-09-18T02:17:00Z");
    expect(availableCalendarVersion(date, ["v2.4.0"])).toBe("2026.9.18");
    expect(availableCalendarVersion(date, ["v2026.9.18"])).toBeNull();
    expect(() => availableCalendarVersion(date, ["v2026.10.1"])).toThrow(/不能倒退/);
    expect(() => availableCalendarVersion(date, ["v2026.9.18", "v2027.1.1"])).toThrow(/不能倒退/);
  });
});

describe("pinned Release Please date integration", () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const github = {
    repository: { owner: "example", repo: "app", defaultBranch: "main" },
    getFileJson: async (path) => JSON.parse(read(path)),
    getFileContentsOnBranch: async (path) => ({ parsedContent: read(path) }),
  };
  it.each(["feat(遠端): 加入功能", "fix(遠端): 修正問題", "feat(設定)!: 調整格式\n\nRelease-As: 99.0.0"])("uses the date throughout the generated PR for %s", async (message) => {
    const manifest = await calendarManifest({ github, version: "2026.9.18" });
    const strategy = await buildStrategy({ github, targetBranch: "main", ...manifest.repositoryConfig["."] });
    const candidate = await strategy.buildReleasePullRequest(
      parseConventionalCommits([{ sha: "a".repeat(40), message, files: [] }]),
      { tag: new TagName(Version.parse("2.4.0")), sha: "b".repeat(40) }, true,
    );
    expect(candidate.version.toString()).toBe("2026.9.18");
    expect(candidate.title.toString()).toBe("chore(main): 發布 2026.9.18");
    expect(candidate.body.toString()).toContain("v2.4.0...v2026.9.18");
    for (const path of ["package.json", "package-lock.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "CHANGELOG.md"]) {
      const updated = candidate.updates.find((entry) => entry.path === path).updater.updateContent(read(path));
      expect(updated).toContain("2026.9.18");
      if (path === "package-lock.json") {
        expect(JSON.parse(updated).packages["node_modules/react"]).toEqual(JSON.parse(read(path)).packages["node_modules/react"]);
      }
      if (path === "CHANGELOG.md") expect(updated).toContain("## [2.4.0]");
    }
  });
  it("requires an explicit date instead of silently falling back to SemVer", async () => {
    await expect(calendarManifest({ github })).rejects.toThrow(/日期版號/);
  });
});
