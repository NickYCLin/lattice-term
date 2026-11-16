import { displayPath } from "./displayPath";
import { projectDirectoryKey, type ProjectDirectoryKey } from "./projectDirectory";
import type { LiveSessionSidebarNode, SessionSidebarLayout } from "./sessionSidebarLayout";

/** Merge only project ids; preserve named folders, manual filing and leaf ids. */
export function mergeDirectoryProjectLayout(layout: SessionSidebarLayout, live: readonly LiveSessionSidebarNode[], key: ProjectDirectoryKey = projectDirectoryKey, observed: readonly string[] = []): SessionSidebarLayout {
  const candidates = new Map<string, Set<string>>();
  const alias = (from: string, to: string) => { const targets = candidates.get(from) ?? new Set(); targets.add(to); candidates.set(from, targets); };
  for (const path of observed) {
    const target = `project:local:${key(path)}`;
    alias(`project:local:${displayPath(path).toLowerCase()}`, target);
    alias(`project:local:${projectDirectoryKey(path)}`, target);
    if (/^[a-z]:[\\/]+$/i.test(displayPath(path))) alias(`project:local:${displayPath(path).slice(0, 2)}`, target);
    alias(`project:native:${projectDirectoryKey(path)}`, target);
  }
  const projectId = (id: string | null): string | null => {
    if (!id) return id;
    const targets = candidates.get(id);
    if (targets?.size === 1) return [...targets][0];
    if (targets && targets.size > 1) return id; // Historical POSIX lowercasing is ambiguous.
    const match = id.match(/^project:(?:local|native):(.*)$/s);
    return match ? `project:local:${key(match[1])}` : id;
  };
  const defaults = new Map(live.map(node => [node.id, node.defaultParentId]));
  const placements: SessionSidebarLayout["placements"] = {};
  const entries = Object.entries(layout.placements).sort(([a, av], [b, bv]) =>
    Number(!!bv.manual) - Number(!!av.manual) || Number(projectId(b) === b) - Number(projectId(a) === a) || av.order - bv.order);
  for (const [id, placement] of entries) {
    const target = projectId(id)!;
    let parentId = projectId(placement.parentId);
    if (!placement.manual && defaults.get(id)?.startsWith("project:")) parentId = defaults.get(id)!;
    if (parentId === target) parentId = null;
    placements[target] ??= { ...placement, parentId };
  }
  return { ...layout, placements, collapsedFolderIds: [...new Set(layout.collapsedFolderIds.map(id => projectId(id)!))] };
}
