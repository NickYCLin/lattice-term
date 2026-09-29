/**
 * Workspace state: the connection collection, the activity log and the filter
 * the connections view renders from.
 *
 * Synchronizes with Rust backend storage in desktop mode, and seamlessly falls
 * back to React in-memory state in browser preview mode.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  appendActivity,
  createActivityEntry,
  type ActivityEntry,
} from "../domain/activity";
import {
  connectionTarget,
  createConnectionProfile,
  findProtocol,
  type ConnectionDraft,
  type ConnectionProfile,
} from "../domain/connection";
import {
  collectTags,
  emptyFilter,
  filterProfiles,
  groupProfiles,
  isFilterActive,
  sortProfiles,
  type ConnectionFilter,
  type SortOrder,
} from "../domain/query";
import { sampleProfiles } from "../domain/samples";

/** `SSH · operator@host:22`, the line shown beside an activity entry. */
function describe(profile: ConnectionProfile): string {
  return `${findProtocol(profile.protocol).acronym} · ${connectionTarget(profile)}`;
}

/// Returns the failure message, or `null` when the save landed (or there is
/// no backend to land in). A desktop-mode failure must not vanish: the entry
/// looks saved on screen but is gone after a restart.
async function syncSaveToBackend(
  profile: ConnectionProfile,
): Promise<string | null> {
  if (!("__TAURI_INTERNALS__" in window)) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_connection_profile", { profile });
    return null;
  } catch (reason) {
    return reason instanceof Error ? reason.message : String(reason);
  }
}

async function syncDeleteToBackend(id: string): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("delete_connection_profile", { id });
}

async function syncReplaceBackend(
  profiles: ConnectionProfile[],
): Promise<string | null> {
  if (!("__TAURI_INTERNALS__" in window)) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("replace_connection_profiles", { profiles });
    return null;
  } catch (reason) {
    return reason instanceof Error ? reason.message : String(reason);
  }
}

export interface WorkspaceBatchResult {
  count: number;
  error: string | null;
}

export function useWorkspace() {
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [filter, setFilter] = useState<ConnectionFilter>(emptyFilter);
  const [sortOrder, setSortOrder] = useState<SortOrder>("name");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);


  const refreshProfiles = useCallback(async (): Promise<void> => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const { invoke } = await import("@tauri-apps/api/core");
    const backendProfiles = await invoke<ConnectionProfile[]>(
      "list_connection_profiles",
    );
    const next = Array.isArray(backendProfiles) ? backendProfiles : [];
    setProfiles(next);
    setSelectedId((current) =>
      current && next.some((profile) => profile.id === current) ? current : null,
    );
  }, []);

  // Sync initial list from Rust backend storage if running inside Tauri
  useEffect(() => {
    let cancelled = false;

    async function loadBackendProfiles() {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const backendProfiles = await invoke<ConnectionProfile[]>(
          "list_connection_profiles",
        );
        if (
          !cancelled &&
          Array.isArray(backendProfiles) &&
          backendProfiles.length > 0
        ) {
          setProfiles(backendProfiles);
        }
      } catch {
        // In-memory fallback for browser
      } finally {
        if (!cancelled) setHydrated(true);
      }
    }

    void loadBackendProfiles();
    return () => {
      cancelled = true;
    };
  }, []);

  const record = useCallback((entry: Omit<ActivityEntry, "id" | "at">) => {
    setActivity((entries) => appendActivity(entries, createActivityEntry(entry)));
  }, []);

  /** Saves to the backend and puts any failure into the activity log. */
  const persist = useCallback(
    (profile: ConnectionProfile) => {
      void syncSaveToBackend(profile).then((failure) => {
        if (failure) {
          record({
            kind: "workspace",
            titleKey: "activity.saveFailed",
            subject: profile.name,
            detail: failure,
          });
        }
      });
    },
    [record],
  );

  const addProfile = useCallback(
    (draft: ConnectionDraft): ConnectionProfile => {
      const profile = createConnectionProfile(draft);
      setProfiles((current) => [...current, profile]);
      setSelectedId(profile.id);
      record({ kind: "created", subject: profile.name, detail: describe(profile) });
      persist(profile);
      return profile;
    },
    [persist, record],
  );

  const updateProfile = useCallback(
    (id: string, draft: ConnectionDraft): ConnectionProfile => {
      const profile = createConnectionProfile(draft, id);
      setProfiles((current) =>
        current.map((entry) => (entry.id === id ? profile : entry)),
      );
      record({ kind: "updated", subject: profile.name, detail: describe(profile) });
      persist(profile);
      return profile;
    },
    [persist, record],
  );

  const duplicateProfile = useCallback(
    (id: string): ConnectionProfile | undefined => {
      const source = profiles.find((entry) => entry.id === id);
      if (!source) return undefined;

      const copy = createConnectionProfile({
        ...source,
        name: `${source.name} (2)`,
        favorite: false,
        machineId: undefined,
      });

      setProfiles((current) => [...current, copy]);
      setSelectedId(copy.id);
      record({
        kind: "created",
        subject: copy.name,
        note: { key: "activity.duplicatedFrom", values: { name: source.name } },
      });
      persist(copy);
      return copy;
    },
    [persist, profiles, record],
  );

  const removeProfile = useCallback(
    async (id: string): Promise<void> => {
      const target = profiles.find((entry) => entry.id === id);
      await syncDeleteToBackend(id);
      setProfiles((current) => current.filter((entry) => entry.id !== id));
      setSelectedId((current) => (current === id ? null : current));
      if (target) {
        record({
          kind: "deleted",
          subject: target.name,
          detail: connectionTarget(target),
        });
      }
    },
    [profiles, record],
  );

  const toggleFavorite = useCallback(
    (id: string): void => {
      // The save happens outside the state updater: updaters can run more
      // than once (StrictMode re-runs them), and a side effect inside one
      // would fire per run.
      const target = profiles.find((entry) => entry.id === id);
      if (!target) return;
      const updated = { ...target, favorite: !target.favorite };
      setProfiles((current) =>
        current.map((entry) => (entry.id === id ? updated : entry)),
      );
      persist(updated);
    },
    [persist, profiles],
  );

  /** Saves a whole-collection change, logging and reporting a failure. */
  const replaceAll = useCallback(
    async (next: ConnectionProfile[]): Promise<string | null> => {
      const failure = await syncReplaceBackend(next);
      if (failure) {
        record({ kind: "workspace", titleKey: "activity.saveFailed", detail: failure });
        return failure;
      }
      setProfiles(next);
      return null;
    },
    [record],
  );

  /**
   * Marks entries as routes to the same computer. Joining an entry that is
   * already linked pulls the others into its existing link.
   */
  const linkProfiles = useCallback(
    async (ids: string[]): Promise<string | null> => {
      const chosen = profiles.filter((entry) => ids.includes(entry.id));
      if (chosen.length < 2) return null;
      const machineId =
        chosen.find((entry) => entry.machineId)?.machineId ?? crypto.randomUUID();
      const previous = new Set(
        chosen.map((entry) => entry.machineId).filter((id): id is string => !!id),
      );
      const next = profiles.map((entry) =>
        ids.includes(entry.id) ||
        (entry.machineId !== undefined && previous.has(entry.machineId))
          ? { ...entry, machineId }
          : entry,
      );
      const failure = await replaceAll(next);
      if (!failure) {
        record({
          kind: "updated",
          subject: chosen.map((entry) => entry.name).join(" + "),
          note: { key: "activity.machineLinked" },
        });
      }
      return failure;
    },
    [profiles, record, replaceAll],
  );

  /** Takes one entry back out of its same-computer card. */
  const unlinkProfile = useCallback(
    async (id: string): Promise<string | null> => {
      const target = profiles.find((entry) => entry.id === id);
      if (!target?.machineId) return null;
      const remaining = profiles.filter(
        (entry) => entry.id !== id && entry.machineId === target.machineId,
      );
      const next = profiles.map((entry) => {
        // A link left with a single member means nothing; clear it too.
        if (entry.id === id || (remaining.length < 2 && entry.machineId === target.machineId)) {
          const { machineId: _dropped, ...rest } = entry;
          return rest;
        }
        return entry;
      });
      const failure = await replaceAll(next);
      if (!failure) {
        record({
          kind: "updated",
          subject: target.name,
          note: { key: "activity.machineUnlinked" },
        });
      }
      return failure;
    },
    [profiles, record, replaceAll],
  );

  const loadSamples = useCallback(async (): Promise<WorkspaceBatchResult> => {
    const loaded = sampleProfiles.map((profile) => ({ ...profile }));
    const failure = await syncReplaceBackend(loaded);
    if (failure) {
      record({
        kind: "workspace",
        titleKey: "activity.saveFailed",
        detail: failure,
      });
      return { count: 0, error: failure };
    }

    setProfiles(loaded);
    setSelectedId(loaded[0]?.id ?? null);
    record({
      kind: "workspace",
      titleKey: "activity.samplesLoaded",
      note: {
        key: "activity.samplesDetail",
        values: { count: sampleProfiles.length },
      },
    });
    return { count: loaded.length, error: null };
  }, [record]);

  /** Imported entries are appended; nothing already in the workspace is lost. */
  const importProfiles = useCallback(
    async (imported: ConnectionProfile[]): Promise<WorkspaceBatchResult> => {
      if (imported.length === 0) return { count: 0, error: null };

      const next = [...profiles, ...imported];
      const failure = await syncReplaceBackend(next);
      if (failure) {
        record({
          kind: "workspace",
          titleKey: "activity.saveFailed",
          detail: failure,
        });
        return { count: 0, error: failure };
      }

      setProfiles(next);
      setSelectedId((current) => current ?? imported[0].id);

      for (const profile of imported) {
        record({
          kind: "created",
          subject: profile.name,
          detail: describe(profile),
        });
      }

      return { count: imported.length, error: null };
    },
    [profiles, record],
  );

  const resetFilter = useCallback((): void => setFilter(emptyFilter), []);

  const clearActivity = useCallback((): void => setActivity([]), []);

  const logActivity = useCallback(
    (entry: {
      type: "created" | "updated" | "deleted" | "workspace";
      message: string;
      detail?: string;
    }) => {
      record({
        kind: entry.type,
        subject: entry.message,
        detail: entry.detail,
      });
    },
    [record],
  );

  const visibleProfiles = useMemo(
    () => sortProfiles(filterProfiles(profiles, filter), sortOrder),
    [profiles, filter, sortOrder],
  );

  const groups = useMemo(() => groupProfiles(profiles), [profiles]);
  const visibleGroups = useMemo(
    () => groupProfiles(visibleProfiles),
    [visibleProfiles],
  );
  const tags = useMemo(() => collectTags(profiles), [profiles]);

  const selected = useMemo(
    () => profiles.find((entry) => entry.id === selectedId) ?? null,
    [profiles, selectedId],
  );

  return {
    profiles,
    hydrated,
    visibleProfiles,
    visibleGroups,
    groups,
    tags,
    activity,
    filter,
    filterActive: isFilterActive(filter),
    sortOrder,
    selected,
    selectedId,
    setFilter,
    resetFilter,
    setSortOrder,
    setSelectedId,
    addProfile,
    updateProfile,
    duplicateProfile,
    removeProfile,
    toggleFavorite,
    linkProfiles,
    unlinkProfile,
    loadSamples,
    importProfiles,
    refreshProfiles,
    clearActivity,
    logActivity,
  };
}

export type WorkspaceState = ReturnType<typeof useWorkspace>;
export type Workspace = WorkspaceState;
