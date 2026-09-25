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

export function useCliUpdates(enabled: boolean) {
  const checked = useRef(false);
  const checking = useRef(false);
  const [busy, setBusy] = useState(false);
  const [updating, setUpdating] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [items, setItems] = useState<CliUpdate[]>([]);
  const [error, setError] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [updated, setUpdated] = useState<string[]>([]);

  const check = useCallback(async () => {
    if (checking.current) return;
    checking.current = true;
    setBusy(true);
    setError(false);
    try {
      setItems(await invoke<CliUpdate[]>("agent_check_updates"));
    } catch {
      setError(true);
    } finally {
      checking.current = false;
      setBusy(false);
    }
  }, []);

  const updateCli = useCallback(
    async (id: string): Promise<boolean> => {
      if (updating !== null) return false;
      setUpdating(id);
      setUpdateError(null);
      const label = items.find((item) => item.id === id)?.label ?? id;
      try {
        await invoke<string>("agent_update_cli", { id });
        setUpdated((current) =>
          current.includes(label) ? current : [...current, label],
        );
        await check();
        return true;
      } catch (err) {
        setUpdateError(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        setUpdating(null);
      }
    },
    [check, items, updating],
  );

  const updateAll = useCallback(async () => {
    if (updating !== null) return;
    const targets = items.filter(
      (item) => item.status === "available" && item.updatable !== false,
    );
    if (targets.length === 0) return;
    setUpdating("all");
    setUpdateError(null);
    // One failing CLI must not leave the rest un-updated or the list stale.
    const failures: string[] = [];
    const succeeded: string[] = [];
    try {
      for (const target of targets) {
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
      await check();
    } finally {
      setUpdating(null);
    }
  }, [check, items, updating]);

  useEffect(() => {
    if (!enabled || checked.current) return;
    checked.current = true;
    void check();
  }, [enabled, check]);

  return {
    items,
    busy,
    updating,
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
        items.some(
          (item) => item.status === "available" || item.status === "error",
        )),
    dismiss: () => setDismissed(true),
  };
}
