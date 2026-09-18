/** Retain three stable downloads; Git tags and changelog history stay intact. */
import { validateUpdaterManifest } from "./validate-updater-manifest.mjs";

const stable = (release) => !release.draft && !release.prerelease && /^v\d+\.\d+\.\d+$/.test(release.tag_name);

export function planReleasePruning(releases, expectedTag) {
  const published = releases.filter(stable);
  if (published.some((release) => !Number.isFinite(Date.parse(release.published_at)))) {
    throw new Error("正式版發布時間不完整，停止清理。");
  }
  published.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at) || b.id - a.id);
  if (published[0]?.tag_name !== expectedTag) throw new Error("最新正式版已變動，停止清理。");
  return { keep: published.slice(0, 3), remove: published.slice(3) };
}

export async function pruneReleases({ github, context, core, expectedTag, fetchManifest = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`公開更新清單讀取失敗：${response.status}`);
  return response.json();
} }) {
  const assertLatest = async () => {
    const { data: latest } = await github.rest.repos.getLatestRelease(context.repo);
    if (!stable(latest) || latest.tag_name !== expectedTag) throw new Error("公開 latest 已變動，停止清理。");
    return latest;
  };
  const latest = await assertLatest();
  const manifest = await fetchManifest(`https://github.com/${context.repo.owner}/${context.repo.repo}/releases/latest/download/latest.json`);
  validateUpdaterManifest(manifest, latest, expectedTag);
  const releases = await github.paginate(github.rest.repos.listReleases, { ...context.repo, per_page: 100 });
  const plan = planReleasePruning(releases, expectedTag);
  core.info(`保留正式版：${plan.keep.map((release) => release.tag_name).join("、")}`);
  for (const release of plan.remove) {
    await assertLatest();
    const { data: fresh } = await github.rest.repos.getRelease({ ...context.repo, release_id: release.id });
    if (!stable(fresh) || fresh.tag_name !== release.tag_name || fresh.updated_at !== release.updated_at || fresh.published_at !== release.published_at) {
      throw new Error(`Release ${release.id} 已變動，停止清理。`);
    }
    await github.rest.repos.deleteRelease({ ...context.repo, release_id: release.id });
    core.info(`已刪除 ${release.tag_name} 的 Release 與安裝包，保留 Git tag。`);
  }
  return plan;
}
