#!/usr/bin/env node
/**
 * One stable channel: pushes maintain the draft PR; daily checks may publish
 * after seven days since the last public release. Commit count and breaking
 * changes never bypass the interval. CI is a separate mandatory gate.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Types that make a non-empty user-facing release.
 *
 * Narrower than what Release Please renders: `style` and `refactor` appear in
 * the changelog but must not push a release over the line on their own.
 */
export const RELEASABLE_TYPES = new Set(["feat", "fix", "perf"]);

export const RELEASE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

const HEADER = /^(?<type>[a-z]+)(?<scope>\([^)]*\))?(?<breaking>!)?:/;

/**
 * Reads one commit's conventional-commit header and body.
 *
 * An unparseable subject is treated as user-visible: guessing that an
 * unlabelled commit is a chore would quietly keep real work unreleased.
 */
export function classifyCommit({ subject, body = "" }) {
  const match = HEADER.exec(subject.trim());
  if (!match) return { type: null, releasable: true, breaking: false };
  const type = match.groups.type;
  return {
    type,
    releasable: RELEASABLE_TYPES.has(type),
    breaking:
      Boolean(match.groups.breaking) || /^BREAKING[ -]CHANGE:/m.test(body),
  };
}

/**
 * @param commits unreleased commits, each `{subject, body}`.
 * `null` means the API confirmed there is no published release yet.
 * Missing or invalid metadata must never be mistaken for a first release.
 */
export function decideRelease({
  commits,
  lastPublishedAt,
  now = Date.now(),
  eventName = "push",
  forced = false,
}) {
  if (!canPublishFrom(eventName)) {
    return { release: false, reason: "pushes only update the draft release PR" };
  }
  const classified = commits.map((commit) => ({
    ...commit,
    ...classifyCommit(commit),
  }));
  const releasable = classified.filter((commit) => commit.releasable || commit.breaking);
  if (releasable.length === 0) {
    // Forcing a version with an empty changelog would ship nothing while
    // still prompting every installation to update.
    return { release: false, reason: "nothing releasable is waiting" };
  }
  return releaseWindow({ lastPublishedAt, now, eventName, forced });
}

export function releaseWindow({ lastPublishedAt, now = Date.now(), eventName = "push", forced = false }) {
  if (!canPublishFrom(eventName)) return { release: false, reason: "pushes only update the draft release PR" };
  const publishedAt = typeof lastPublishedAt === "string" ? Date.parse(lastPublishedAt) : NaN;
  if (!Number.isFinite(now) || (lastPublishedAt !== null && (!Number.isFinite(publishedAt) || publishedAt > now))) {
    return { release: false, reason: "missing or invalid publication timestamp" };
  }
  if (forced && eventName === "workflow_dispatch") {
    return { release: true, reason: "explicit emergency release; CI is still required" };
  }
  if (lastPublishedAt === null || now - publishedAt >= RELEASE_INTERVAL_MS) {
    return { release: true, reason: "new changes are ready for the weekly stable release" };
  }
  return {
    release: false,
    reason: "fewer than seven days since the last published stable release",
  };
}

export function canPublishFrom(eventName) {
  return eventName === "schedule" || eventName === "workflow_dispatch";
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

/** Commits not yet included in the last publicly released stable version. */
export function unreleasedCommits(lastPublishedTag) {
  if (lastPublishedTag !== null && !/^v\d+\.\d+\.\d+$/.test(lastPublishedTag ?? "")) {
    throw new Error("A confirmed stable release tag or explicit null is required.");
  }
  // Draft/unpublished tags do not consume changes or restart the release clock.
  const range = lastPublishedTag === null ? "HEAD" : `${lastPublishedTag}..HEAD`;
  // A record separator keeps multi-line bodies from being mistaken for the
  // start of the next commit.
  const raw = git("log", range, "--no-merges", "--format=%H%x1f%s%x1f%b%x1e");
  return raw
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [, subject, body] = entry.split("\x1f");
      return { subject, body: body ?? "" };
    });
}

function main() {
  const commits = unreleasedCommits(process.env.RELEASE_LAST_TAG === "none" ? null : process.env.RELEASE_LAST_TAG);
  const decision = decideRelease({
    commits,
    lastPublishedAt: process.env.RELEASE_LAST_PUBLISHED_AT === "none" ? null : process.env.RELEASE_LAST_PUBLISHED_AT,
    eventName: process.env.GITHUB_EVENT_NAME,
    forced: process.env.RELEASE_FORCE === "true",
  });
  const summary = `release=${decision.release} (${decision.reason})`;
  console.log(summary);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `release=${decision.release}\nreason=${decision.reason}\n`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
