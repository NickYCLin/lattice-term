import { useRef, useState } from "react";

export function useSessionClose(selectedSessionId: string | null = null) {
  const selected = useRef(selectedSessionId);
  selected.current = selectedSessionId;
  const inFlight = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  async function run(sessionId: string, action: () => Promise<void>) {
    if (inFlight.current.has(sessionId)) return;
    inFlight.current.add(sessionId);
    setPending(new Set(inFlight.current));
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      inFlight.current.delete(sessionId);
      setPending(new Set(inFlight.current));
    }
  }

  return { pending, error, dismiss: () => setError(null), run,
    isCurrent: (sessionId: string) => selected.current === sessionId };
}
