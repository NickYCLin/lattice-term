/** GitHub orchestration for the single stable release channel. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { canPublishFrom, decideRelease, releaseWindow, unreleasedCommits } from "./decide-release.mjs";

const stableTag = /^v\d+\.\d+\.\d+$/;
const shaPattern = /^[a-f0-9]{40}$/;

export function releaseState(releases, version) {
  const stable = releases.filter((release) => !release.draft && !release.prerelease && stableTag.test(release.tag_name));
  if (stable.some((release) => !Number.isFinite(Date.parse(release.published_at)))) {
    throw new Error("Stable release publication metadata is invalid.");
  }
  stable.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
  const current = releases.find((release) => release.tag_name === `v${version}` && !release.prerelease);
  if (current?.draft && stable[0]) {
    const currentParts = version.split(".").map(BigInt);
    const latestParts = stable[0].tag_name.slice(1).split(".").map(BigInt);
    const different = currentParts.findIndex((part, index) => part !== latestParts[index]);
    if (different < 0 || currentParts[different] < latestParts[different]) {
      throw new Error("Refusing to resume an obsolete draft release.");
    }
  }
  return { latest: stable[0] ?? null, draft: current?.draft ? current : null, currentPublished: Boolean(current && !current.draft) };
}

function isReleasePr(pr, context) {
  return pr.base.ref === "main" && pr.head.ref.startsWith("release-please--") &&
    pr.head.repo?.full_name === `${context.repo.owner}/${context.repo.repo}` && pr.user.type === "Bot";
}

async function releasePrs(github, context, state) {
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    ...context.repo, state, labels: "autorelease: pending", per_page: 100,
  });
  const pulls = await Promise.all(issues.filter((issue) => issue.pull_request).map(async (issue) =>
    (await github.rest.pulls.get({ ...context.repo, pull_number: issue.number })).data));
  return pulls.filter((pr) => isReleasePr(pr, context));
}

async function assertAncestor(github, context, ancestor, descendant) {
  if (!shaPattern.test(ancestor) || !shaPattern.test(descendant)) throw new Error("Invalid release commit.");
  const { data } = await github.rest.repos.compareCommitsWithBasehead({
    ...context.repo, basehead: `${ancestor}...${descendant}`,
  });
  if (!["ahead", "identical"].includes(data.status)) throw new Error("Release candidate does not contain the expected main snapshot.");
}

/** Read-only discovery. Only the current manifest version can be retried;
 * obsolete draft releases must not be promoted over a newer public release. */
export async function inspectRelease({ github, context, version, sourceSha }) {
  if (!stableTag.test(`v${version}`) || !shaPattern.test(sourceSha)) throw new Error("Invalid release snapshot.");
  const releases = await github.paginate(github.rest.repos.listReleases, { ...context.repo, per_page: 100 });
  const state = releaseState(releases, version);
  const metadata = {
    sourceSha,
    lastPublishedAt: state.latest?.published_at ?? null,
    lastPublishedTag: state.latest?.tag_name ?? null,
    recovery: null,
  };
  if (state.draft) {
    const { data: commit } = await github.rest.repos.getCommit({ ...context.repo, ref: state.draft.tag_name });
    await assertAncestor(github, context, commit.sha, sourceSha);
    metadata.recovery = { mode: "draft", candidate_sha: commit.sha, tag_name: state.draft.tag_name };
  } else if (!state.currentPublished) {
    const pending = (await releasePrs(github, context, "closed")).filter((pr) => pr.merged_at);
    for (const pr of pending) {
      const { data: file } = await github.rest.repos.getContent({
        ...context.repo, path: ".release-please-manifest.json", ref: pr.merge_commit_sha,
      });
      const manifest = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
      if (manifest["."] !== version) continue;
      if (metadata.recovery) throw new Error("Multiple pending release merges require investigation.");
      await assertAncestor(github, context, pr.merge_commit_sha, sourceSha);
      metadata.recovery = { mode: "merged", candidate_sha: pr.merge_commit_sha, tag_name: `v${version}` };
    }
  }
  return metadata;
}

/**
 * Release Please only rewrites its PR when the release notes change, so a
 * later docs/test/chore commit on main leaves the PR based on an older main.
 * That PR can never pass the snapshot check below, and the scheduled release
 * would stall until some unrelated fix landed. Merge the exact main snapshot
 * into the bot's PR branch (GitHub's "update branch", guarded by the head we
 * read) and return the new head; conflicts or races fail instead of guessing.
 */
async function catchUpReleasePr(github, context, core, pr, sourceSha, wait) {
  const { data } = await github.rest.repos.compareCommitsWithBasehead({
    ...context.repo, basehead: `${sourceSha}...${pr.head.sha}`,
  });
  if (["ahead", "identical"].includes(data.status)) return pr.head.sha;
  core.info(`Release PR #${pr.number} predates main ${sourceSha}; bringing it up to date.`);
  await github.rest.pulls.updateBranch({ ...context.repo, pull_number: pr.number, expected_head_sha: pr.head.sha });
  for (let attempt = 0; attempt < 30; attempt++) {
    await wait(2000);
    const { data: fresh } = await github.rest.pulls.get({ ...context.repo, pull_number: pr.number });
    if (fresh.head.sha === pr.head.sha) continue;
    if (!isReleasePr(fresh, context) || fresh.state !== "open") throw new Error("Release PR changed while it was being updated.");
    return fresh.head.sha;
  }
  throw new Error("Release PR did not pick up the main snapshot in time.");
}

export async function prepareRelease({ github, context, core, metadata, commits, forced = false, now = Date.now(), wait = (ms) => new Promise((done) => setTimeout(done, ms)) }) {
  core.setOutput("ready", "false");
  if (!canPublishFrom(context.eventName)) {
    core.info("Push: update the draft PR only; no release approval is needed at the scheduled check.");
    return;
  }
  if (metadata.recovery) {
    const window = releaseWindow({ lastPublishedAt: metadata.lastPublishedAt, eventName: context.eventName, forced, now });
    core.info(window.reason);
    if (!window.release) return;
    // Finishing an unpublished version is not a new release or a new tag.
    const plan = { ...metadata.recovery, source_sha: metadata.sourceSha };
    for (const [key, value] of Object.entries(plan)) core.setOutput(key, value);
    core.setOutput("ready", "true");
    return;
  }
  const decision = decideRelease({ commits, lastPublishedAt: metadata.lastPublishedAt, eventName: context.eventName, forced, now });
  core.info(decision.reason);
  if (!decision.release) return;
  const pulls = await releasePrs(github, context, "open");
  if (pulls.length === 0) { core.info("No pending release PR."); return; }
  if (pulls.length !== 1) throw new Error("Expected exactly one pending release PR.");
  const pr = pulls[0];
  const { data: main } = await github.rest.git.getRef({ ...context.repo, ref: "heads/main" });
  if (main.object.sha !== metadata.sourceSha) { core.info("Main advanced; retry at the next scheduled check."); return; }
  const candidateSha = await catchUpReleasePr(github, context, core, pr, metadata.sourceSha, wait);
  await assertAncestor(github, context, metadata.sourceSha, candidateSha);
  for (const [key, value] of Object.entries({
    mode: "new", candidate_sha: candidateSha, source_sha: metadata.sourceSha, pr_number: pr.number,
  })) core.setOutput(key, value);
  core.setOutput("ready", "true");
}

export function assertMergeSnapshot(mergedCommit, candidateCommit, sourceSha) {
  if (mergedCommit.parents?.[0]?.sha !== sourceSha || mergedCommit.commit.tree.sha !== candidateCommit.commit.tree.sha) {
    throw new Error("Merged release differs from the CI-verified snapshot; do not publish.");
  }
}

/** Called only by the job that depends on successful candidate CI. */
export async function mergeRelease({ github, context, plan }) {
  if (!["new", "draft", "merged"].includes(plan.mode) || !shaPattern.test(plan.candidate_sha)) {
    throw new Error("Invalid verified release plan.");
  }
  const { data: candidate } = await github.rest.repos.getCommit({ ...context.repo, ref: plan.candidate_sha });
  if (plan.mode !== "new") {
    // Recheck the tag/commit before resuming installer uploads.
    if (plan.mode === "draft") {
      const releases = await github.paginate(github.rest.repos.listReleases, { ...context.repo, per_page: 100 });
      if (!releases.some((release) => release.tag_name === plan.tag_name && release.draft && !release.prerelease)) {
        throw new Error("Recovery release is no longer a draft; refusing to overwrite a public version.");
      }
      const { data: tagged } = await github.rest.repos.getCommit({ ...context.repo, ref: plan.tag_name });
      if (tagged.sha !== candidate.sha) throw new Error("Recovery tag moved after verification.");
    }
    return candidate.sha;
  }
  const { data: main } = await github.rest.git.getRef({ ...context.repo, ref: "heads/main" });
  const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: Number(plan.pr_number) });
  if (main.object.sha !== plan.source_sha || pr.head.sha !== plan.candidate_sha || pr.state !== "open" || !isReleasePr(pr, context)) {
    throw new Error("Main or the release PR changed during CI; retry without publishing.");
  }
  if (pr.draft) await github.graphql("mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { id } } }", { id: pr.node_id });
  const { data: result } = await github.rest.pulls.merge({
    ...context.repo, pull_number: pr.number, sha: plan.candidate_sha, merge_method: "squash",
  });
  if (!result.merged) throw new Error("Release PR was not merged.");
  const { data: merged } = await github.rest.repos.getCommit({ ...context.repo, ref: result.sha });
  assertMergeSnapshot(merged, candidate, plan.source_sha);
  // Remove only the unchanged merged bot branch, never newer collaborator work.
  try {
    const { data: branch } = await github.rest.git.getRef({ ...context.repo, ref: `heads/${pr.head.ref}` });
    if (branch.object.sha === plan.candidate_sha) await github.rest.git.deleteRef({ ...context.repo, ref: `heads/${pr.head.ref}` });
  } catch { /* GitHub may already have auto-deleted the merged branch. */ }
  return result.sha;
}

export function checkoutMetadata() {
  return {
    version: JSON.parse(readFileSync(".release-please-manifest.json", "utf8"))["."],
    sourceSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  };
}

export { unreleasedCommits };
