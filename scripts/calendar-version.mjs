/**
 * Calendar versions for the single release channel: `YYYY.M.N` — the year,
 * the month without a leading zero, and which release of that month this is.
 *
 * The shape is still valid SemVer, so Cargo, npm, Tauri and the release gate
 * keep working unchanged, and it orders correctly across month and year
 * boundaries (2026.9.2 < 2026.10.1 < 2027.1.1).
 *
 * Release Please only knows how to derive a version from commit types, so it
 * proposes a semantic one and this retargets the generated Release PR before
 * that version reaches a tag. Everything happens on the PR branch: `main` is
 * never written to, so the immutable candidate snapshot the release gate
 * depends on is untouched.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const VERSION = /^\d+\.\d+\.\d+$/;

/** The release's own month decides the version, in UTC. The daily schedule
 * runs at 02:17 UTC (10:17 in Taipei), so both clocks name the same day. */
export function nextCalendarVersion(date, tags) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const prefix = `v${year}.${month}.`;
  const used = tags
    .map((tag) => tag.trim())
    .filter((tag) => tag.startsWith(prefix))
    .map((tag) => Number(tag.slice(prefix.length)))
    .filter((sequence) => Number.isSafeInteger(sequence) && sequence > 0);
  // A gap left by an abandoned draft is not reused: a number that was once
  // attached to a tag must not name a different build later.
  return `${year}.${month}.${used.length === 0 ? 1 : Math.max(...used) + 1}`;
}

function replaceExactly(label, text, pattern, replacement, expected) {
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== expected) {
    throw new Error(`${label}：預期 ${expected} 處版本，實際 ${matches.length} 處。`);
  }
  return text.replace(pattern, replacement);
}

function escape(version) {
  return version.replace(/\./g, "\\.");
}

/** Rewrites one file's version in place in the text, keeping its formatting.
 * `package-lock.json` is bounded to its header so a dependency that happens
 * to carry the same version string is never touched. */
export function retargetFile(path, text, from, to) {
  const quoted = escape(from);
  switch (path) {
    case "package.json":
    case "src-tauri/tauri.conf.json":
      return replaceExactly(path, text, new RegExp(`("version":\\s*")${quoted}(")`, "g"), `$1${to}$2`, 1);
    case "package-lock.json": {
      // The project's own version appears twice, at the root and in the
      // `packages[""]` entry; both sit before the first installed package.
      const boundary = text.indexOf('"node_modules/');
      const split = boundary < 0 ? text.length : boundary;
      const head = replaceExactly(path, text.slice(0, split), new RegExp(`("version":\\s*")${quoted}(")`, "g"), `$1${to}$2`, 2);
      return head + text.slice(split);
    }
    case ".release-please-manifest.json":
      return replaceExactly(path, text, new RegExp(`("\\.":\\s*")${quoted}(")`, "g"), `$1${to}$2`, 1);
    case "src-tauri/Cargo.toml": {
      const start = text.search(/^\[package\]/m);
      if (start < 0) throw new Error("src-tauri/Cargo.toml 找不到 [package] 區段。");
      const offset = text.slice(start + 1).search(/^\[/m);
      const end = offset < 0 ? text.length : start + 1 + offset;
      const section = replaceExactly(path, text.slice(start, end), new RegExp(`(^version\\s*=\\s*")${quoted}(")`, "gm"), `$1${to}$2`, 1);
      return text.slice(0, start) + section + text.slice(end);
    }
    case "CHANGELOG.md":
      // Only this release's heading, which carries the version twice: once as
      // the link text and once as the compare target.
      return replaceExactly(
        path,
        text,
        new RegExp(`^## \\[${quoted}]\\((\\S+?)\\.\\.\\.v${quoted}\\)`, "gm"),
        `## [${to}]($1...v${to})`,
        1,
      );
    default:
      throw new Error(`未知的版本檔案：${path}`);
  }
}

export const VERSION_FILES = [
  "package.json",
  "package-lock.json",
  ".release-please-manifest.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "CHANGELOG.md",
];

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const read = (path) => readFileSync(resolve(root, path), "utf8");
  const from = JSON.parse(read(".release-please-manifest.json"))["."];
  if (typeof from !== "string" || !VERSION.test(from)) {
    throw new Error(`.release-please-manifest.json 沒有有效的版本：${String(from)}`);
  }
  const tags = execFileSync("git", ["tag", "--list", "v*"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const to = nextCalendarVersion(new Date(), tags);
  if (to === from) {
    console.log(`版本已是日曆版號 ${to}，不需改寫。`);
    return;
  }
  const updated = VERSION_FILES.map((path) => [path, retargetFile(path, read(path), from, to)]);
  for (const [path, text] of updated) writeFileSync(resolve(root, path), text, "utf8");
  console.log(`已將待發布版本從 ${from} 改寫為日曆版號 ${to}（${VERSION_FILES.length} 個檔案）。`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
