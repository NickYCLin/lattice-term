import { describe, expect, it, vi } from "vitest";
import { retryRelease } from "./retry-release.mjs";

function fixture() {
  const run = { id: 42, name: "Release", path: ".github/workflows/release.yml",
    head_repository: { full_name: "example/app" }, head_branch: "main", event: "schedule",
    status: "completed", conclusion: "failure", run_attempt: 1 };
  const jobs = [
    { name: "Build & upload (Windows amd64)", conclusion: "failure" },
    { name: "Build & upload (Linux amd64)", conclusion: "success" },
    { name: "Publish the finished release", conclusion: "skipped" },
  ];
  const actions = { getWorkflowRun: vi.fn(async () => ({ data: run })),
    listJobsForWorkflowRun: vi.fn(), reRunWorkflowFailedJobs: vi.fn() };
  return { run, jobs, github: { rest: { actions }, paginate: vi.fn(async () => jobs) },
    context: { repo: { owner: "example", repo: "app" }, payload: { workflow_run: { ...run } } },
    core: { info: vi.fn(), warning: vi.fn() } };
}

describe("bounded release build recovery", () => {
  it.each([1, 2])("retries failed platforms in the original run after attempt %s", async (attempt) => {
    const f = fixture(); f.run.run_attempt = f.context.payload.workflow_run.run_attempt = attempt;
    await retryRelease(f);
    expect(f.github.rest.actions.reRunWorkflowFailedJobs).toHaveBeenCalledExactlyOnceWith({ owner: "example", repo: "app", run_id: 42 });
    expect(f.github.paginate).toHaveBeenCalledWith(f.github.rest.actions.listJobsForWorkflowRun,
      expect.objectContaining({ filter: "latest" }));
  });
  it("stops after three attempts with a visible warning", async () => {
    const f = fixture(); f.run.run_attempt = f.context.payload.workflow_run.run_attempt = 3;
    await retryRelease(f);
    expect(f.core.warning).toHaveBeenCalledOnce();
    expect(f.github.rest.actions.reRunWorkflowFailedJobs).not.toHaveBeenCalled();
  });
  it.each([{ event: "push" }, { event: "pull_request" }, { head_branch: "feature" },
    { head_repository: { full_name: "other/fork" } }, { name: "CI" }, { path: ".github/workflows/other.yml" }])(
    "ignores untrusted or unrelated events %j", async (change) => {
      const f = fixture(); Object.assign(f.context.payload.workflow_run, change);
      await retryRelease(f); expect(f.github.rest.actions.getWorkflowRun).not.toHaveBeenCalled();
    });
  it.each([{ status: "in_progress" }, { conclusion: "success" }, { conclusion: "cancelled" },
    { run_attempt: 2 }, { head_branch: "other" }])("ignores stale events after run changes %j", async (change) => {
    const f = fixture(); Object.assign(f.run, change); await retryRelease(f);
    expect(f.github.rest.actions.reRunWorkflowFailedJobs).not.toHaveBeenCalled();
  });
  it.each(["Verify the exact release candidate / Linux quick check", "Automatically merge or resume the verified release",
    "Publish the finished release", "Build & upload (Android APK)"])("does not retry failures in %s", async (name) => {
    const f = fixture(); f.jobs.push({ name, conclusion: "failure" }); await retryRelease(f);
    expect(f.github.rest.actions.reRunWorkflowFailedJobs).not.toHaveBeenCalled();
  });
  it.each(["success", "failure", "cancelled"])("does not retry after publication is %s", async (conclusion) => {
    const f = fixture(); f.jobs[2].conclusion = conclusion; await retryRelease(f);
    expect(f.github.rest.actions.reRunWorkflowFailedJobs).not.toHaveBeenCalled();
  });
  it("does not infer success from a failed API request", async () => {
    const f = fixture(); f.github.paginate.mockRejectedValue(new Error("API unavailable"));
    await expect(retryRelease(f)).rejects.toThrow("API unavailable");
    expect(f.github.rest.actions.reRunWorkflowFailedJobs).not.toHaveBeenCalled();
  });
});
