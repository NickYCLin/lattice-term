import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { assertMergeSnapshot, inspectRelease, mergeRelease, prepareRelease, releaseState } from "./release-gate.mjs";

const source = "a".repeat(40);
const head = "b".repeat(40);
const merged = "c".repeat(40);
const changed = "d".repeat(40);
const tree = "e".repeat(40);
const now = Date.parse("2026-09-15T02:17:00Z");
const published = "2026-09-07T08:05:33Z";
const context = { repo: { owner: "example", repo: "app" }, eventName: "schedule" };
const release = (tag_name, extra = {}) => ({ tag_name, draft: false, prerelease: false, published_at: published, ...extra });
const pr = (extra = {}) => ({
  number: 10, node_id: "PR_fixture", user: { type: "Bot" }, state: "open", draft: true,
  base: { ref: "main" }, head: { ref: "release-please--main", sha: head, repo: { full_name: "example/app" } },
  ...extra,
});
const commit = (sha, parent = source, treeSha = tree) => ({ sha, parents: [{ sha: parent }], commit: { tree: { sha: treeSha } } });
const metadata = { sourceSha: source, lastPublishedAt: published, lastPublishedTag: "v2.0.0", recovery: null };
const plan = { mode: "new", candidate_sha: head, source_sha: source, pr_number: "10" };

function fixture() {
  const outputs = {};
  const core = { info: vi.fn(), setOutput: vi.fn((key, value) => { outputs[key] = value; }) };
  const rest = {
    repos: {
      listReleases: vi.fn(), compareCommitsWithBasehead: vi.fn().mockResolvedValue({ data: { status: "ahead" } }),
      getCommit: vi.fn(async ({ ref }) => ({ data: commit(ref === "v2.0.1" ? head : ref) })),
      getContent: vi.fn().mockResolvedValue({ data: { content: Buffer.from('{".":"2.0.1"}').toString("base64") } }),
    },
    issues: { listForRepo: vi.fn() },
    pulls: { get: vi.fn().mockResolvedValue({ data: pr() }), merge: vi.fn().mockResolvedValue({ data: { merged: true, sha: merged } }), updateBranch: vi.fn() },
    git: { getRef: vi.fn(async ({ ref }) => ({ data: { object: { sha: ref === "heads/main" ? source : head } } })), deleteRef: vi.fn() },
  };
  const github = {
    rest, graphql: vi.fn(),
    paginate: vi.fn(async (method) => method === rest.repos.listReleases ? [release("v2.0.0")] : [{ number: 10, pull_request: {} }]),
  };
  return { github, core, outputs, context, metadata, commits: [{ subject: "fix(ui): 修正提示" }], now, wait: vi.fn(async () => {}) };
}

describe("published release metadata", () => {
  it("uses publication time instead of tag creation order and ignores other channels", () => {
    const state = releaseState([
      release("v2.1.0", { draft: true, published_at: null }),
      release("v9.0.0", { prerelease: true }),
      release("v2.0.0", { published_at: "2026-09-01T00:00:00Z" }),
      release("v1.9.1", { published_at: published }),
    ], "2.1.0");
    expect(state.latest.tag_name).toBe("v1.9.1");
    expect(state.draft.tag_name).toBe("v2.1.0");
  });
  it("does not retry an unrelated old draft", () => {
    expect(releaseState([release("v1.2.0", { draft: true }), release("v2.0.0")], "2.0.0").draft).toBeNull();
    expect(() => releaseState([release("v1.2.0", { draft: true }), release("v2.0.0")], "1.2.0")).toThrow(/obsolete/);
  });
  it("rejects corrupt publication dates", () => {
    expect(() => releaseState([release("v2.0.0", { published_at: null })], "2.0.0")).toThrow(/metadata/);
  });
  it("does not treat a failed GitHub request as an empty release history", async () => {
    const f = fixture(); f.github.paginate.mockRejectedValue(new Error("unavailable"));
    await expect(inspectRelease({ ...f, version: "2.0.0", sourceSha: source })).rejects.toThrow("unavailable");
  });
  it("discovers an unfinished draft by its immutable tag commit", async () => {
    const f = fixture();
    f.github.paginate.mockResolvedValue([release("v2.0.0"), release("v2.0.1", { draft: true })]);
    const result = await inspectRelease({ ...f, version: "2.0.1", sourceSha: source });
    expect(result.recovery).toEqual({ mode: "draft", candidate_sha: head, tag_name: "v2.0.1" });
    expect(f.github.rest.pulls.merge).not.toHaveBeenCalled();
  });
  it("recovers a merged PR if tag creation was interrupted", async () => {
    const f = fixture();
    f.github.rest.pulls.get.mockResolvedValue({ data: pr({ state: "closed", merged_at: published, merge_commit_sha: merged }) });
    const result = await inspectRelease({ ...f, version: "2.0.1", sourceSha: source });
    expect(result.recovery).toEqual({ mode: "merged", candidate_sha: merged, tag_name: "v2.0.1" });
  });
});

describe("release candidate selection", () => {
  it("pushes never merge or retry releases", async () => {
    const f = fixture();
    await prepareRelease({ ...f, context: { ...context, eventName: "push" }, metadata: { ...metadata, recovery: { mode: "draft" } } });
    expect(f.outputs.ready).toBe("false"); expect(f.github.paginate).not.toHaveBeenCalled();
  });
  it("selects the PR head for full CI after the interval", async () => {
    const f = fixture(); await prepareRelease(f);
    expect(f.outputs).toMatchObject({ ready: "true", candidate_sha: head, source_sha: source, pr_number: 10 });
    expect(f.github.rest.pulls.merge).not.toHaveBeenCalled();
  });
  it("holds when main advances while the PR is being prepared", async () => {
    const f = fixture(); f.github.rest.git.getRef.mockResolvedValue({ data: { object: { sha: changed } } });
    await prepareRelease(f); expect(f.outputs.ready).toBe("false");
  });
  it.each(["behind", "diverged"])("rejects a %s candidate that cannot be brought up to date", async (status) => {
    const f = fixture(); f.github.rest.repos.compareCommitsWithBasehead.mockResolvedValue({ data: { status } });
    f.github.rest.pulls.updateBranch.mockRejectedValue(new Error("merge conflict"));
    await expect(prepareRelease(f)).rejects.toThrow(/conflict/);
    expect(f.outputs.ready).toBe("false");
  });
  it("brings a Release PR left behind by a docs/test commit up to main, then selects the new head", async () => {
    const f = fixture();
    f.github.rest.repos.compareCommitsWithBasehead
      .mockResolvedValueOnce({ data: { status: "diverged" } })
      .mockResolvedValue({ data: { status: "ahead" } });
    f.github.rest.pulls.get
      .mockResolvedValueOnce({ data: pr() }) // listing the open release PR
      .mockResolvedValueOnce({ data: pr() }) // update still in progress
      .mockResolvedValue({ data: pr({ head: { ...pr().head, sha: changed } }) });
    await prepareRelease(f);
    expect(f.github.rest.pulls.updateBranch).toHaveBeenCalledWith({ owner: "example", repo: "app", pull_number: 10, expected_head_sha: head });
    expect(f.outputs).toMatchObject({ ready: "true", candidate_sha: changed, source_sha: source });
  });
  it("does not select a PR that a person took over while it was being updated", async () => {
    const f = fixture();
    f.github.rest.repos.compareCommitsWithBasehead.mockResolvedValueOnce({ data: { status: "behind" } });
    f.github.rest.pulls.get
      .mockResolvedValueOnce({ data: pr() })
      .mockResolvedValue({ data: pr({ user: { type: "User" }, head: { ...pr().head, sha: changed } }) });
    await expect(prepareRelease(f)).rejects.toThrow(/changed while/);
    expect(f.outputs.ready).toBe("false");
  });
  it("does not touch an up-to-date Release PR", async () => {
    const f = fixture(); await prepareRelease(f);
    expect(f.github.rest.pulls.updateBranch).not.toHaveBeenCalled();
  });
  it("does not promote arbitrary human-created or fork PRs", async () => {
    for (const unsafe of [pr({ user: { type: "User" } }), pr({ head: { ...pr().head, repo: { full_name: "other/fork" } } })]) {
      const f = fixture(); f.github.rest.pulls.get.mockResolvedValue({ data: unsafe });
      await prepareRelease(f); expect(f.outputs.ready).toBe("false");
    }
  });
  it("retries an existing draft without creating a new tag, still respecting cadence", async () => {
    const f = fixture();
    const recovery = { mode: "draft", candidate_sha: head, tag_name: "v2.0.1" };
    await prepareRelease({ ...f, commits: [], metadata: { ...metadata, recovery } });
    expect(f.outputs).toMatchObject({ ready: "true", ...recovery });
    const recent = fixture();
    await prepareRelease({ ...recent, commits: [], metadata: { ...metadata, recovery, lastPublishedAt: new Date(now - 1000).toISOString() } });
    expect(recent.outputs.ready).toBe("false");
  });
});

describe("CI-verified merge boundary", () => {
  it("rejects invalid plans before calling GitHub", async () => {
    for (const invalid of [{ ...plan, mode: "unknown" }, { ...plan, candidate_sha: "main" }]) {
      const f = fixture();
      await expect(mergeRelease({ ...f, plan: invalid })).rejects.toThrow(/Invalid/);
      expect(f.github.rest.repos.getCommit).not.toHaveBeenCalled();
    }
  });
  it("automatically readies and merges exactly the verified PR head", async () => {
    const f = fixture(); expect(await mergeRelease({ ...f, plan })).toBe(merged);
    expect(f.github.graphql).toHaveBeenCalledOnce();
    expect(f.github.rest.pulls.merge).toHaveBeenCalledWith(expect.objectContaining({ sha: head, merge_method: "squash" }));
    expect(f.github.rest.git.deleteRef).toHaveBeenCalledWith(expect.objectContaining({ ref: "heads/release-please--main" }));
  });
  it("leaves collaborator changes on the merged branch intact", async () => {
    const f = fixture();
    f.github.rest.git.getRef.mockImplementation(async ({ ref }) => ({ data: { object: { sha: ref === "heads/main" ? source : changed } } }));
    await mergeRelease({ ...f, plan }); expect(f.github.rest.git.deleteRef).not.toHaveBeenCalled();
  });
  it.each(["main", "pr"])("refuses to merge if %s changed during CI", async (target) => {
    const f = fixture();
    if (target === "main") f.github.rest.git.getRef.mockResolvedValue({ data: { object: { sha: changed } } });
    else f.github.rest.pulls.get.mockResolvedValue({ data: pr({ head: { ...pr().head, sha: changed } }) });
    await expect(mergeRelease({ ...f, plan })).rejects.toThrow(/changed/);
    expect(f.github.rest.pulls.merge).not.toHaveBeenCalled(); expect(f.github.graphql).not.toHaveBeenCalled();
  });
  it("blocks publishing if the merge races with a new base or changes the tested tree", () => {
    expect(() => assertMergeSnapshot(commit(merged, changed), commit(head), source)).toThrow(/snapshot/);
    expect(() => assertMergeSnapshot(commit(merged, source, changed), commit(head), source)).toThrow(/snapshot/);
    expect(() => assertMergeSnapshot(commit(merged), commit(head), source)).not.toThrow();
  });
  it("refuses to overwrite a now-published release or moved recovery tag", async () => {
    const f = fixture(); const recoveryPlan = { ...plan, mode: "draft", tag_name: "v2.0.1" };
    await expect(mergeRelease({ ...f, plan: recoveryPlan })).rejects.toThrow(/no longer a draft/);
    f.github.paginate.mockResolvedValue([release("v2.0.1", { draft: true })]);
    f.github.rest.repos.getCommit.mockImplementation(async ({ ref }) => ({ data: commit(ref.startsWith("v") ? changed : ref) }));
    await expect(mergeRelease({ ...f, plan: recoveryPlan })).rejects.toThrow(/tag moved/);
  });
});

describe("release workflow wiring", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  it("checks daily and keeps releases behind the reusable candidate CI", () => {
    expect(workflow).toContain("cron: '17 2 * * *'");
    expect(workflow).toContain("skip-github-release: true");
    expect(workflow).toContain("needs: [release-plan, verify-candidate]");
    expect(workflow).toContain("ref: ${{ needs.release-plan.outputs.candidate_sha }}");
    expect(ci).toContain("workflow_call:");
    expect(ci).toContain("ref: ${{ inputs.ref || github.sha }}");
    expect(workflow).toContain("prerelease: false");
    expect(workflow).not.toContain("gh pr merge");
  });
});
