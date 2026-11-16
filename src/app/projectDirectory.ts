/** Lexical identity only. Filesystem aliases need a successful local canonical lookup. */
export function projectDirectoryKey(path: string): string {
  let plain = path.replace(/^[/\\]{2}\?[/\\]UNC[/\\]/i, "//").replace(/^[/\\]{2}\?[/\\]/, "");
  const windows = /^[a-z]:[\\/]/i.test(plain) || /^[\\/]{2}[^\\/]/.test(plain);
  if (windows) {
    plain = plain.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
    if (/^[\\/]{2}/.test(path) && !/^[a-z]:/i.test(plain)) plain = "/" + plain;
    const wsl = plain.match(/^\/\/(?:wsl\$|wsl\.localhost)\/([^/]+)(.*)$/i);
    if (wsl) return `//wsl.localhost/${wsl[1].toLowerCase()}${wsl[2].replace(/\/+$/, "")}`;
    if (/^[a-z]:\/+$/i.test(plain)) return plain.slice(0, 2).toLowerCase() + "/";
    return plain.replace(/\/+$/, "").toLowerCase();
  }
  return plain.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || (plain.startsWith("/") ? "/" : plain);
}

export type ProjectDirectoryKey = (path: string) => string;
export function localProjectId(path: string, key: ProjectDirectoryKey = projectDirectoryKey): string {
  return `local:${key(path)}`;
}
export function projectParentPath(path: string): string {
  const normalized = projectDirectoryKey(path);
  const index = normalized.lastIndexOf("/");
  return index < 0 ? normalized : normalized.slice(0, index) || "/";
}
/** Only duplicate names need a parent hint. Never group by basename. */
export function disambiguateProjectLabels<T extends { id: string; label: string; workingDirectory: string | null }>(projects: readonly T[], key: ProjectDirectoryKey = projectDirectoryKey): T[] {
  const counts = new Map<string, number>();
  for (const project of projects) counts.set(project.label.toLowerCase(), (counts.get(project.label.toLowerCase()) ?? 0) + 1);
  return projects.map(project => {
    if (!project.workingDirectory || (counts.get(project.label.toLowerCase()) ?? 0) < 2) return project;
    const parent = projectParentPath(key(project.workingDirectory));
    const peers = projects.filter(other => other.id !== project.id && other.workingDirectory && other.label.toLowerCase() === project.label.toLowerCase())
      .map(other => projectParentPath(key(other.workingDirectory!)));
    const parts = parent.split("/").filter(Boolean);
    let hint = parent;
    for (let length = 1; length < parts.length; length++) {
      const suffix = parts.slice(-length).join("/");
      if (peers.every(other => other.split("/").filter(Boolean).slice(-length).join("/") !== suffix)) { hint = `…/${suffix}`; break; }
    }
    return { ...project, label: `${project.label} · ${hint}` };
  });
}
