import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { hasDesktopBackend } from "./nativeRuntime";
import { jevErrorKey, prepareJevPreview, validJevPreview, type JevAdvice } from "./jevAdvice";
import type { MessageKey } from "../i18n/messages/zh-TW";

export function useJevAdvisor() {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [consent, setConsent] = useState(false);
  const [result, setResult] = useState<JevAdvice | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const epoch = useRef(0);
  const inFlight = useRef(false);
  const configuring = useRef(false);
  useEffect(() => {
    let active = true;
    if (!hasDesktopBackend()) { setLoading(false); return; }
    void invoke<boolean>("jev_enabled").then(value => { if (active) setEnabled(value); })
      .catch(reason => { if (active) setError(jevErrorKey(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; epoch.current++; };
  }, []);

  function reset() {
    epoch.current++;
    setText(""); setConsent(false); setResult(null); setError(null);
  }
  async function configure(key: string | null) {
    if (configuring.current) return;
    configuring.current = true;
    setLoading(true);
    reset();
    try {
      await invoke("jev_configure", { key });
      setEnabled(key !== null);
    } catch (reason) {
      setError(jevErrorKey(reason));
    } finally { configuring.current = false; setLoading(false); }
  }
  function select(id: string) {
    reset();
    setSessionId(id);
  }
  async function preview() {
    if (!enabled || !sessionId || inFlight.current) return;
    inFlight.current = true;
    reset();
    const ticket = epoch.current;
    setBusy(true);
    try {
      const snapshot = await invoke<{ base64: string }>("jev_preview", { sessionId });
      const decoded = new TextDecoder().decode(Uint8Array.from(atob(snapshot.base64), c => c.charCodeAt(0)));
      if (ticket === epoch.current) setText(prepareJevPreview(decoded));
    } catch (reason) {
      if (ticket === epoch.current) setError(jevErrorKey(reason));
    } finally { inFlight.current = false; setBusy(false); }
  }
  function edit(value: string) {
    epoch.current++;
    setText(value); setConsent(false); setResult(null); setError(null);
  }
  async function analyze() {
    if (!enabled || !consent || !validJevPreview(text) || inFlight.current) return;
    inFlight.current = true;
    const ticket = ++epoch.current;
    setBusy(true); setResult(null); setError(null);
    try {
      const advice = await invoke<JevAdvice>("jev_analyze", { text, consent: true });
      if (ticket === epoch.current) {
        setResult(advice);
        setConsent(false);
      }
    } catch (reason) {
      if (ticket === epoch.current) setError(jevErrorKey(reason));
    } finally { inFlight.current = false; setBusy(false); }
  }
  return { enabled, loading, busy, text, sessionId, consent, result, error, configure, select, preview, edit, analyze, setConsent };
}
