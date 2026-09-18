import { describe, expect, it } from "vitest";
import { nextCalendarVersion, retargetFile } from "./calendar-version.mjs";

const september = new Date(Date.UTC(2026, 8, 18, 2, 17));

describe("calendar version numbers", () => {
  it("starts a month at one and counts on from the tags already used", () => {
    expect(nextCalendarVersion(september, [])).toBe("2026.9.1");
    expect(nextCalendarVersion(september, ["v2026.9.1"])).toBe("2026.9.2");
    // A month with nothing released yet starts again at one, and last
    // month's tags do not carry over.
    expect(nextCalendarVersion(new Date(Date.UTC(2026, 9, 2)), ["v2026.9.1", "v2026.9.2"])).toBe("2026.10.1");
    expect(nextCalendarVersion(new Date(Date.UTC(2027, 0, 8)), ["v2026.12.4"])).toBe("2027.1.1");
  });

  it("never reuses a number an abandoned draft already took", () => {
    expect(nextCalendarVersion(september, ["v2026.9.1", "v2026.9.3"])).toBe("2026.9.4");
  });

  it("ignores tags that are not this month's calendar versions", () => {
    const tags = ["v2.4.0", "v2026.9.1", "v2026.90.1", "v2026.9.x", "v2026.9.", "not-a-tag"];
    expect(nextCalendarVersion(september, tags)).toBe("2026.9.2");
  });

  it("orders correctly across month and year boundaries", () => {
    const compare = (left, right) => {
      const a = left.split(".").map(Number);
      const b = right.split(".").map(Number);
      return a.findIndex((part, index) => part !== b[index]) < 0
        ? 0
        : Math.sign(a[a.findIndex((part, index) => part !== b[index])] - b[a.findIndex((part, index) => part !== b[index])]);
    };
    const ordered = ["2026.9.2", "2026.10.1", "2027.1.1"];
    for (let index = 1; index < ordered.length; index += 1) {
      expect(compare(ordered[index], ordered[index - 1])).toBe(1);
    }
    // No leading zero: 2026.09.1 would not be a valid SemVer.
    expect(nextCalendarVersion(september, [])).not.toMatch(/\.0\d/);
  });
});

describe("retargeting the generated release", () => {
  it("rewrites each version source without touching anything else", () => {
    expect(retargetFile("package.json", '{\n  "name": "lattice-term",\n  "version": "2.5.0",\n  "dependencies": { "react": "2.5.0" }\n}', "2.5.0", "2026.9.1"))
      .toContain('"version": "2026.9.1"');
    expect(retargetFile(".release-please-manifest.json", '{\n  ".": "2.5.0"\n}\n', "2.5.0", "2026.9.1"))
      .toBe('{\n  ".": "2026.9.1"\n}\n');
    expect(retargetFile("src-tauri/tauri.conf.json", '{\n  "version": "2.5.0"\n}\n', "2.5.0", "2026.9.1"))
      .toBe('{\n  "version": "2026.9.1"\n}\n');
  });

  it("leaves a dependency that shares the release version alone", () => {
    const lock = [
      "{",
      '  "name": "lattice-term",',
      '  "version": "2.5.0",',
      '  "lockfileVersion": 3,',
      '  "packages": {',
      '    "": {',
      '      "name": "lattice-term",',
      '      "version": "2.5.0",',
      '      "dependencies": {}',
      "    },",
      '    "node_modules/thing": {',
      '      "version": "2.5.0"',
      "    }",
      "  }",
      "}",
    ].join("\n");
    const updated = retargetFile("package-lock.json", lock, "2.5.0", "2026.9.1");
    expect(updated.split("2026.9.1")).toHaveLength(3);
    expect(updated).toContain('"node_modules/thing": {\n      "version": "2.5.0"');
  });

  it("rewrites only the package version in Cargo.toml", () => {
    const toml = '[package]\nname = "lattice-term"\nversion = "2.5.0"\n\n[dependencies]\nserde = "2.5.0"\n';
    expect(retargetFile("src-tauri/Cargo.toml", toml, "2.5.0", "2026.9.1"))
      .toBe('[package]\nname = "lattice-term"\nversion = "2026.9.1"\n\n[dependencies]\nserde = "2.5.0"\n');
  });

  it("rewrites this release's changelog heading and leaves older ones", () => {
    const changelog = [
      "# 更新日誌",
      "",
      "## [2.5.0](https://example.invalid/compare/v2.4.0...v2.5.0) (2026-09-18)",
      "",
      "* 新增了什麼",
      "",
      "## [2.4.0](https://example.invalid/compare/v2.3.0...v2.4.0) (2026-09-16)",
    ].join("\n");
    const updated = retargetFile("CHANGELOG.md", changelog, "2.5.0", "2026.9.1");
    expect(updated).toContain("## [2026.9.1](https://example.invalid/compare/v2.4.0...v2026.9.1) (2026-09-18)");
    expect(updated).toContain("## [2.4.0](https://example.invalid/compare/v2.3.0...v2.4.0) (2026-09-16)");
  });

  it("refuses to guess when a file does not hold the version it expects", () => {
    expect(() => retargetFile("package.json", '{\n  "name": "x"\n}', "2.5.0", "2026.9.1")).toThrow(/預期 1 處/);
    expect(() => retargetFile("src-tauri/Cargo.toml", 'name = "x"\n', "2.5.0", "2026.9.1")).toThrow(/\[package\]/);
    expect(() => retargetFile("unknown.json", "{}", "2.5.0", "2026.9.1")).toThrow(/未知的版本檔案/);
  });
});
