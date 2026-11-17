import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../i18n/context";
import { hasDesktopBackend } from "../../app/nativeRuntime";
type Probe = { holder: { kind: string; pid: number } | null; available: boolean };
/** Explicitly requested waiting, never repeated user-message submission. */
export function CodexWriterHandoff({ nativeId, profile, onRetry }: {
  nativeId: string; profile?: string | null; onRetry: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [probe, setProbe] = useState<Probe | null>(null), [waiting, setWaiting] = useState(false), [error, setError] = useState(false);
  const generation = useRef(0), started = useRef(0);
  useEffect(() => {
    if (!hasDesktopBackend()) return;
    let disposed = false, busy = false;
    const expected = ++generation.current;
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const next = await invoke<Probe>("codex_thread_holder", { nativeId, profile: profile ?? null });
        if (disposed || expected !== generation.current) return;
        setProbe(next);
        if (waiting && next.available) {
          generation.current++; setWaiting(false);
          await onRetry(); // One explicit retry after the lock probe; no uncertain-delivery replay.
        } else if (waiting && Date.now() - started.current >= 120_000) { setWaiting(false); setError(true); }
      } catch { if (!disposed) { setError(true); setWaiting(false); } }
      finally { busy = false; }
    };
    void poll(); const timer = window.setInterval(() => { void poll(); }, 2000);
    return () => { disposed = true; generation.current++; window.clearInterval(timer); };
  }, [nativeId, profile, waiting]);
  return <div>
    {probe?.holder && <p>{t("handoff.holder", { kind: probe.holder.kind === "codex_desktop" ? "Codex Desktop" : probe.holder.kind === "latticeterm" ? "LatticeTerm" : t("handoff.unknown"), pid: probe.holder.pid })}</p>}
    <div className="chat-callout__actions">
      <button className="button button--secondary button--sm" disabled={waiting} onClick={() => { void onRetry().catch(() => setError(true)); }}>{t("handoff.retry")}</button>
      <button className="button button--ghost button--sm" onClick={() => {
        generation.current++; setError(false); started.current = Date.now(); setWaiting(value => !value);
      }}>{t(waiting ? "handoff.cancel" : "handoff.take")}</button>
    </div>
    {waiting && <p role="status">{t("handoff.waiting")}</p>}
    {error && <p role="alert">{t("handoff.waitFailed")}</p>}
  </div>;
}
