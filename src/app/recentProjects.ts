import { projectDirectoryKey } from "./projectDirectory";
export interface RecentProject { path: string; at: number }
export interface CheckedProject extends RecentProject { canonicalPath: string | null }
const KEY = "latticeterm.recentChatProjects.v1";
function valid(path: unknown): path is string { return typeof path === "string" && path.length <= 4096 && /^(?:\/|[a-z]:[\\/]|~\/|\\\\)/i.test(path) && !/[\u0000-\u001f\u007f]/.test(path); }
export function readRecentProjects(): RecentProject[] {
  try { const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]"); return Array.isArray(value) ? value.filter((item): item is RecentProject => Boolean(item && valid(item.path) && Number.isFinite(item.at))).slice(0, 64) : []; } catch { return []; }
}
export function recordRecentProject(path: string, at = Date.now()) {
  if (!valid(path)) return;
  const rows = [{ path, at }, ...readRecentProjects().filter(item => projectDirectoryKey(item.path) !== projectDirectoryKey(path))].slice(0, 64);
  try { localStorage.setItem(KEY, JSON.stringify(rows)); } catch { /* Existing conversation still retains the selected path. */ }
}
export function projectCandidates(rows: readonly RecentProject[]): RecentProject[] {
  const seen = new Set<string>();
  return [...rows].filter(row => valid(row.path) && Number.isFinite(row.at)).sort((a,b) => b.at-a.at).filter(row => {
    const key = projectDirectoryKey(row.path); if (seen.has(key)) return false; seen.add(key); return true;
  }).slice(0,256);
}
export function checkedRecentProjects(rows: readonly RecentProject[], identities: readonly { path: string; canonicalPath: string | null }[], query = ""): CheckedProject[] {
  const verified = new Map(identities.map(row => [row.path, row.canonicalPath]));
  const seen = new Set<string>(), needle = query.trim().toLocaleLowerCase();
  return projectCandidates(rows).flatMap(row => {
    const canonicalPath = verified.get(row.path) ?? null, key = projectDirectoryKey(canonicalPath ?? row.path);
    if (seen.has(key)) return []; seen.add(key);
    return row.path.toLocaleLowerCase().includes(needle) || canonicalPath?.toLocaleLowerCase().includes(needle) ? [{ ...row, canonicalPath }] : [];
  }).slice(0,8);
}
