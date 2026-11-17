import { useCallback, useEffect, useState } from "react";
import { hasDesktopBackend } from "./nativeRuntime";

export const PROMPT_STUCK_AFTER_MS = 30_000;

export interface PromptReadiness {
  writerHolder?: { kind: string; pid: number } | null;
  ready: boolean;
  blockers: string[];
  basis: string;
  unconfirmedMs: number | null;
  reconciled?: boolean;
}

const READINESS_MESSAGE_KEYS = {
  thread_locked_by_other_writer: "handoff.locked",
  integration_not_reported: "sessionChat.readiness.integration_not_reported",
  terminal_turn_unconfirmed: "sessionChat.readiness.terminal_turn_unconfirmed",
  lifecycle_not_ready: "sessionChat.readiness.lifecycle_not_ready",
  approval_pending: "sessionChat.readiness.approval_pending",
  terminal_output_unsettled: "sessionChat.readiness.terminal_output_unsettled",
  terminal_screen_unknown: "sessionChat.readiness.terminal_screen_unknown",
  desktop_editing: "sessionChat.readiness.desktop_editing",
  desktop_paste_incomplete: "sessionChat.readiness.desktop_paste_incomplete",
  desktop_escape_incomplete: "sessionChat.readiness.desktop_escape_incomplete",
  startup_seed_pending: "sessionChat.readiness.startup_seed_pending",
  queued_prompts_pending: "sessionChat.readiness.queued_prompts_pending",
  control_not_granted: "sessionChat.readiness.control_not_granted",
  input_profile_unsupported: "sessionChat.readiness.input_profile_unsupported",
} as const;

export function readinessReasonKey(code: string) {
  return READINESS_MESSAGE_KEYS[code as keyof typeof READINESS_MESSAGE_KEYS] ?? null;
}

async function core() {
  return import("@tauri-apps/api/core");
}

export function usePromptReadiness(sessionId: string | null, enabled: boolean) {
  const [value, setValue] = useState<PromptReadiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const refresh = useCallback(async () => {
    if (!sessionId || !enabled || !hasDesktopBackend()) {
      setValue(null);
      setError(null);
      return null;
    }
    try {
      const { invoke } = await core();
      const next = await invoke<PromptReadiness>("agent_prompt_readiness", { sessionId });
      setValue(next);
      setError(null);
      return next;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return null;
    }
  }, [sessionId, enabled]);

  useEffect(() => {
    if (!enabled || !sessionId || !hasDesktopBackend()) {
      setValue(null);
      setError(null);
      return;
    }
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 5000);
    return () => window.clearInterval(timer);
  }, [sessionId, enabled, refresh]);

  const reconcile = useCallback(async () => {
    if (!sessionId || !hasDesktopBackend()) return null;
    setPending(true);
    try {
      const { invoke } = await core();
      const next = await invoke<PromptReadiness>("agent_reconcile_prompt", { sessionId });
      setValue(next);
      setError(null);
      return next;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return null;
    } finally {
      setPending(false);
    }
  }, [sessionId]);

  return { value, error, pending, refresh, reconcile };
}
