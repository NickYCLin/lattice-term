import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const RELEASE_HEADING = /^## \[([^\]]+)\](?:\([^\n]+\))?(?: \([^\n]+\))?\s*$/gm;
const COMMIT_LINK = / \(\[[0-9a-f]{7,40}\]\(https:\/\/github\.com\/[^)]+\/commit\/[0-9a-f]{7,40}\)\)$/gim;
const TRAILING_REFERENCE_LINKS = /(?:\s+\(\[[^\]\r\n]+\]\(https:\/\/github\.com\/[^)\r\n]+\)\))+\s*$/;

function normalizeTag(tag) {
  const normalized = tag.trim();
  if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(normalized)) {
    throw new Error(`無效的版本標籤：${tag}`);
  }
  return normalized;
}

function extractReleaseSection(changelog, version) {
  const headings = [...changelog.matchAll(RELEASE_HEADING)];
  const headingIndex = headings.findIndex((match) => match[1] === version);
  if (headingIndex === -1) {
    throw new Error(`CHANGELOG.md 找不到 ${version} 的版本段落`);
  }

  const start = headings[headingIndex].index + headings[headingIndex][0].length;
  const end = headings[headingIndex + 1]?.index ?? changelog.length;
  return changelog.slice(start, end).trim().replace(/\n---\s*$/, "").trim();
}

export function deduplicateChangelogEntries(changelog) {
  const seenEntries = new Set();

  return changelog
    .split("\n")
    .filter((line) => {
      if (/^## \[/.test(line)) {
        seenEntries.clear();
        return true;
      }
      if (!/^[*-] /.test(line)) return true;

      const normalizedEntry = line
        .replace(/^[*-] /, "")
        .replace(COMMIT_LINK, "")
        .trim();
      if (seenEntries.has(normalizedEntry)) return false;
      seenEntries.add(normalizedEntry);
      return true;
    })
    .join("\n");
}

function normalizeReleaseBody(section) {
  const body = deduplicateChangelogEntries(section)
    .replace(/^### /gm, "## ")
    .replace(/^## 🛠️ 問題修正[^\S\r\n]*$/gm, "## 🛠️ 問題修正與優化")
    .replace(COMMIT_LINK, "")
    .replace(/^[*-] \*\*([^*\n]+):\*\* /gm, "- **$1**：")
    .replace(/^\* /gm, "- ")
    .replace(/^(## .+)\n(?=- )/gm, "$1\n\n")
    .replace(/\n(## )/g, "\n\n$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!body) {
    throw new Error("版本說明不可為空白");
  }
  return body;
}

function deriveSubtitle(body) {
  const items = [...body.matchAll(/^-[^\S\r\n]+\*\*([^*]+)\*\*(?:[：:][^\S\r\n]*)?(.*)$/gm)];
  if (!items.length) return "版本更新";

  if (items.length > 1) {
    // Scopes differ only in case across commits ("MCP" / "mcp"); count
    // them once, keeping the first spelling the changelog shows.
    const seen = new Set();
    const subjects = items
      .map((item) => item[1].replace(/[：:]$/, "").trim())
      .filter((subject) => {
        const key = subject.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 3);
    if (subjects.length === 1) return subjects[0];

    const last = subjects.pop();
    const conjunction = /^\p{Script=Han}/u.test(last) ? "與" : "與 ";
    return `${subjects.join("、")}${conjunction}${last}`;
  }

  const subject = items[0][1].replace(/[：:]$/, "").trim();
  const summary = items[0][2]
    .replace(/^[：:][^\S\r\n]*/, "")
    .replace(TRAILING_REFERENCE_LINKS, "")
    .replace(/[。：:]$/, "")
    .trim();
  const subtitle = summary ? `${subject}：${summary}` : subject;
  return [...subtitle].slice(0, 56).join("");
}

export function buildReleaseMetadata(changelog, inputTag) {
  const tag = normalizeTag(inputTag);
  const version = tag.slice(1);
  const body = normalizeReleaseBody(extractReleaseSection(changelog, version));

  return {
    name: `LatticeTerm ${tag} - ${deriveSubtitle(body)}`,
    body,
  };
}

function main() {
  const [, , inputTag, outputPath] = process.argv;
  if (!inputTag || !outputPath) {
    throw new Error("用法：node scripts/render-release-metadata.mjs <tag> <output-file>");
  }

  const changelogPath = path.resolve("CHANGELOG.md");
  const metadata = buildReleaseMetadata(fs.readFileSync(changelogPath, "utf8"), inputTag);
  fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
