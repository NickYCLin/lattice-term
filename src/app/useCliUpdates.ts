import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface CliUpdate {
  id: string;
  label: string;
  currentVersion: string | null;
  latestVersion: string | null;
  status: "available" | "current" | "manual" | "error";
  sourceUrl: string;
}

export function useCliUpdates(enabled: boolean) {
  const checked = useRef(false);
  const checking = useRef(false);
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<CliUpdate[]>([]);
  const [error, setError] = useState(false);
  const [dismissed, setDismissed] = useState(false);
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
  useEffect(() => {
    if (!enabled || checked.current) return;
    checked.current = true;
    void check();
  }, [enabled, check]);
  return {
    items, busy, error, check,
    visible: !dismissed && (error || items.some((item) => item.status === "available" || item.status === "error")),
    dismiss: () => setDismissed(true),
  };
}
