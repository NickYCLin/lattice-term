// Retry the original run, so successful platforms and the verified SHA survive.
// Never retry merge/publish failures: they may already have changed public state.
export async function retryRelease({ github, context, core }) {
  const eventRun = context.payload.workflow_run;
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  const trusted = (run) => run?.name === "Release" &&
    run.path === ".github/workflows/release.yml" &&
    run.head_repository?.full_name === repository && run.head_branch === "main" &&
    ["schedule", "workflow_dispatch"].includes(run.event);
  if (!trusted(eventRun)) return;

  const { data: run } = await github.rest.actions.getWorkflowRun({ ...context.repo, run_id: eventRun.id });
  if (!trusted(run) || run.status !== "completed" || run.conclusion !== "failure" ||
      run.run_attempt !== eventRun.run_attempt) return;
  if (run.run_attempt >= 3) {
    core.warning(`Release ${run.id} has failed after ${run.run_attempt} attempts; inspect the original run.`);
    return;
  }
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...context.repo, run_id: run.id, filter: "latest", per_page: 100,
  });
  const failed = jobs.filter((job) => ["failure", "timed_out"].includes(job.conclusion));
  const desktopBuild = /^Build & upload \((Linux amd64|Linux arm64|Windows amd64|macOS arm64|macOS Intel)\)$/;
  if (!failed.length || failed.some((job) => !desktopBuild.test(job.name)) ||
      jobs.some((job) => job.conclusion === "cancelled") ||
      !jobs.some((job) => job.name === "Publish the finished release" && job.conclusion === "skipped")) {
    core.info("Failure is outside desktop packaging; retain it for inspection.");
    return;
  }
  await github.rest.actions.reRunWorkflowFailedJobs({ ...context.repo, run_id: run.id });
  core.info(`Requested attempt ${run.run_attempt + 1}/3 for failed desktop jobs in Release ${run.id}.`);
}
