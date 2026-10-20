import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface CliUpdate {
  id: string;
  label: string;
  currentVersion: string | null;
  latestVersion: string | null;
  status: "available" | "current" | "manual" | "error";
  sourceUrl: string;
  updatable?: boolean;
}

export interface CliUpdateProgress {
  activeId: string | null;
  label: string;
  completed: number;
  total: number;
  phase: "updating" | "checking";
}

function needsAttention(items: CliUpdate[]) {
  return items.some(
    (item) => item.status === "available" || item.status === "error",
  );
}

export function useCliUpdates(enabled: boolean) {
  const checked = useRef(false);
  const checking = useRef(false);
  const updateRunning = useRef(false);
  const [progress, setProgress] = useState<CliUpdateProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [updating, setUpdating] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [items, setItems] = useState<CliUpdate[]>([]);
  const [error, setError] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [updated, setUpdated] = useState<string[]>([]);

  const check = useCallback(async (): Promise<CliUpdate[] | null> => {
    if (checking.current) return null;
    checking.current = true;
    setBusy(true);
    setError(false);
    try {
      const next = await invoke<CliUpdate[]>("agent_check_updates");
      setItems(next);
      return next;
    } catch {
      setError(true);
      return null;
    } finally {
      checking.current = false;
      setBusy(false);
    }
  }, []);

  const updateCli = useCallback(
    async (id: string): Promise<boolean> => {
      if (updateRunning.current) return false;
      updateRunning.current = true;
      setUpdating(id);
      setUpdateError(null);
      const label = items.find((item) => item.id === id)?.label ?? id;
      setProgress({ activeId: id, label, completed: 0, total: 1, phase: "updating" });
      try {
        await invoke<string>("agent_update_cli", { id });
        setUpdated((current) =>
          current.includes(label) ? current : [...current, label],
        );
        setProgress({ activeId: null, label, completed: 1, total: 1, phase: "checking" });
        const refreshed = await check();
        if (refreshed && !needsAttention(refreshed)) setDismissed(true);
        return true;
      } catch (err) {
        setUpdateError(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        updateRunning.current = false;
        setProgress(null);
        setUpdating(null);
      }
    },
    [check, items],
  );

  const updateAll = useCallback(async () => {
    if (updateRunning.current) return;
    const targets = items.filter(
      (item) => item.status === "available" && item.updatable !== false,
    );
    if (targets.length === 0) return;
    updateRunning.current = true;
    setUpdating("all");
    setUpdateError(null);
    // One failing CLI must not leave the rest un-updated or the list stale.
    const failures: string[] = [];
    const succeeded: string[] = [];
    try {
      for (const target of targets) {
        setProgress({
          activeId: target.id, label: target.label,
          completed: succeeded.length + failures.length, total: targets.length,
          phase: "updating",
        });
        try {
          await invoke<string>("agent_update_cli", { id: target.id });
          succeeded.push(target.label);
        } catch (err) {
          failures.push(
            `${target.label}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (succeeded.length > 0) {
        setUpdated((current) => [
          ...current,
          ...succeeded.filter((label) => !current.includes(label)),
        ]);
      }
      if (failures.length > 0) setUpdateError(failures.join("\n"));
      setProgress({
        activeId: null, label: "", completed: targets.length,
        total: targets.length, phase: "checking",
      });
      const refreshed = await check();
      if (failures.length === 0 && refreshed && !needsAttention(refreshed)) {
        setDismissed(true);
      }
    } finally {
      updateRunning.current = false;
      setProgress(null);
      setUpdating(null);
    }
  }, [check, items]);

  useEffect(() => {
    if (!enabled || checked.current) return;
    checked.current = true;
    void check();
  }, [enabled, check]);

  return {
    items,
    busy,
    updating,
    progress,
    error,
    updateError,
    updated,
    check,
    updateCli,
    updateAll,
    visible:
      !dismissed &&
      (error ||
        updated.length > 0 ||
        needsAttention(items)),
    dismiss: () => setDismissed(true),
  };
}
