import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { hasDesktopBackend } from "./nativeRuntime";
import { projectDirectoryKey } from "./projectDirectory";

/** Sidebar grouping only: never rewrites launch paths, accounts or permissions. */
export function useProjectDirectoryIdentity(paths: readonly string[]) {
  const signature = JSON.stringify([...new Set(paths.filter(Boolean))].sort());
  const [canonical, setCanonical] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    if (!hasDesktopBackend()) return;
    let disposed = false;
    const requested: string[] = JSON.parse(signature);
    void (async () => {
      const next = new Map<string, string>();
      for (let offset = 0; offset < requested.length; offset += 256) {
        if (disposed) return;
        const batch = requested.slice(offset, offset + 256);
        const result = await invoke<{ path: string; canonicalPath: string | null }[]>("project_directory_identities", { paths: batch });
        if (!Array.isArray(result)) throw new Error("Unsupported directory lookup");
        for (const item of result) if (batch.includes(item.path) && typeof item.canonicalPath === "string") {
          next.set(projectDirectoryKey(item.path), projectDirectoryKey(item.canonicalPath));
        }
      }
      if (!disposed) setCanonical(next);
    })().catch(() => { if (!disposed) setCanonical(new Map()); }); // Missing, foreign or older backends keep lexical grouping.
    return () => { disposed = true; };
  }, [signature]);
  return useMemo(() => ({ key: (path: string) => canonical.get(projectDirectoryKey(path)) ?? projectDirectoryKey(path) }), [canonical]);
}
