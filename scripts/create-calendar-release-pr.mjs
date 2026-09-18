import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { GitHub, Manifest } from "release-please";
import { availableCalendarVersion } from "./calendar-version.mjs";

export async function calendarManifest({ github, version }) {
  if (!/^\d{4}\.[1-9]\d?\.[1-9]\d?$/.test(version ?? "")) throw new Error("必須指定日期版號。");
  // Use Release Please's own explicit-version API, so files, PR title/body,
  // changelog and eventual release tag all use one version from the start.
  return Manifest.fromManifest(
    github, "main", "release-please-config.json", ".release-please-manifest.json",
    {}, undefined, version,
  );
}

export async function createCalendarReleasePr({ github, version, dryRun = false }) {
  const manifest = await calendarManifest({ github, version });
  return dryRun ? manifest.buildPullRequests() : manifest.createPullRequests();
}

async function main() {
  const tags = execFileSync("git", ["tag", "--list", "v*"], { encoding: "utf8" }).trim().split("\n");
  const version = availableCalendarVersion(new Date(), tags);
  let pulls = [];
  if (version) {
    const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? "").split("/");
    if (!owner || !repo || !process.env.GITHUB_TOKEN) throw new Error("缺少 GitHub repository 或 token。");
    const github = await GitHub.create({ owner, repo, token: process.env.GITHUB_TOKEN, defaultBranch: "main" });
    pulls = (await createCalendarReleasePr({ github, version })).filter(Boolean);
    if (pulls.length > 1) throw new Error("單一產品不應產生多個 Release PR。");
    console.log(`已整理日期版號 ${version} 的待發布清單。`);
  } else {
    console.log("今天的版號已有 tag，保留後續變更到下一個發布日。");
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
    `version_available=${Boolean(version)}\nprs_created=${pulls.length > 0}\npr=${pulls[0] ? JSON.stringify(pulls[0]) : ""}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
