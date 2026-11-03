import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DatabaseProfile, DatabaseSnapshot } from "../domain/database";

/** Lists connection metadata only; never retrieves passwords or opens a database. */
export function useDatabaseCatalog(enabled: boolean, revision = 0) {
  const [profiles, setProfiles] = useState<DatabaseProfile[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(enabled);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!enabled) return;
    const request = ++generation.current;
    setLoading(true);
    try {
      const snapshot = await invoke<DatabaseSnapshot>("database_profiles");
      if (!snapshot || !Array.isArray(snapshot.profiles)) throw new Error("無法讀取資料庫連線清單。");
      if (request === generation.current) { setProfiles(snapshot.profiles); setError(""); }
    } catch (reason) { if (request === generation.current) setError(String(reason)); }
    finally { if (request === generation.current) setLoading(false); }
  }, [enabled]);
  useEffect(() => {
    if (!enabled) { setProfiles([]); setLoading(false); return; }
    void refresh();
    return () => { generation.current++; };
  }, [enabled, revision, refresh]);
  return { profiles, error, loading, refresh };
}
