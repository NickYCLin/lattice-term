import { useEffect } from "react";
import { hasDesktopBackend } from "./nativeRuntime";
export function useCodexHandoffPresence(selected: string | null, minutes: number) {
  useEffect(() => {
    if (!hasDesktopBackend()) return;
    let disposed = false;
    const publish = () => {
      const active = document.visibilityState !== "hidden" && (document.hasFocus?.() ?? true);
      void import("@tauri-apps/api/core").then(({ invoke }) => {
        if (!disposed) return invoke("agent_handoff_presence", { selected: active ? selected : null, timeoutMs: minutes * 60000 });
      }).catch(() => {});
    };
    publish(); const timer = window.setInterval(publish, 5000);
    window.addEventListener("focus", publish); window.addEventListener("blur", publish); document.addEventListener("visibilitychange", publish);
    return () => { disposed = true; window.clearInterval(timer); window.removeEventListener("focus", publish); window.removeEventListener("blur", publish); document.removeEventListener("visibilitychange", publish); };
  }, [selected, minutes]);
}
