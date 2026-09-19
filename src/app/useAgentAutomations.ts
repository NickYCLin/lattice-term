/**
 * Runs scheduled automations through chat mode.
 *
 * A tick every half minute asks the pure model what is due, opens a chat
 * thread for each run and sends the instructions. The thread's own turn
 * lifecycle reports back: when it ends, the run's outcome is recorded and
 * the thread is flagged unread so the thread list works as an inbox.
 *
 * Mounted at the application root, not in the chat view, so schedules keep
 * firing while another view is open.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AUTOMATIONS_RESTORED_EVENT,
  beginAutomationRun,
  createAutomation,
  dueAutomations,
  finishAutomationRun,
  isAutomationRunning,
  loadStoredAutomations,
  mergeBackgroundStatus,
  recordBackgroundRun,
  saveStoredAutomations,
  setAutomationEnabled,
  triggerDependents,
  updateAutomation,
  type Automation,
  type AutomationDraft,
  type AutomationStatusRecord,
  type BackgroundRunRecord,
} from "./agentAutomations";
import { hasDesktopBackend } from "./nativeRuntime";
import type { AgentChatApi } from "./useAgentChat";

const TICK_MS = 30_000;

export interface AgentAutomationsApi {
  automations: Automation[];
  create: (draft: AutomationDraft) => Automation;
  update: (id: string, draft: AutomationDraft) => void;
  setEnabled: (id: string, enabled: boolean) => void;
  remove: (id: string) => void;
  /** Starts a run right away without touching the planned time. */
  runNow: (id: string) => void;
  /** Runs that ended and have not been opened yet. */
  unreadCount: number;
}

function runTitle(automation: Pick<Automation, "name">, at: Date, locale: string): string {
  const stamp = new Intl.DateTimeFormat(locale, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(at);
  return `${automation.name} · ${stamp}`;
}

export function useAgentAutomations(chat: AgentChatApi, locale: string): AgentAutomationsApi {
  const [automations, setAutomations] = useState<Automation[]>(() =>
    typeof localStorage === "undefined" ? [] : loadStoredAutomations(localStorage),
  );
  const automationsRef = useRef(automations);
  automationsRef.current = automations;
  const chatRef = useRef(chat);
  chatRef.current = chat;
  // Starts whose run entry is not in state yet. They count against the cap
  // so two ticks in one render cycle cannot overshoot it.
  const inFlight = useRef(new Set<string>());
  /** Automations the background service is running right now. */
  const backgroundRunning = useRef(new Set<string>());
  /** The service's finished runs have been taken in; until then no tick. */
  const backgroundReady = useRef(!hasDesktopBackend());

  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    saveStoredAutomations(localStorage, automations);
  }, [automations]);

  // A backup restore rewrites the stored list underneath this hook; take it
  // in before the next save would put the old list back.
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    const reload = () => setAutomations(loadStoredAutomations(localStorage));
    window.addEventListener(AUTOMATIONS_RESTORED_EVENT, reload);
    return () => window.removeEventListener(AUTOMATIONS_RESTORED_EVENT, reload);
  }, []);

  const start = useCallback(
    (automation: Automation, scheduled: boolean) => {
      const now = new Date();
      const thread = chatRef.current.createThread({
        definitionId: automation.definitionId,
        workingDirectory: automation.workingDirectory,
        // Never "ask": nobody is there to answer. The model already refuses
        // to store one, but a stale value must not reach the CLI either.
        permission: automation.permission === "ask" ? "readOnly" : automation.permission,
        model: automation.model,
        title: runTitle(automation, now, locale),
        automationId: automation.id,
        activate: false,
      });
      const runId = crypto.randomUUID();
      inFlight.current.add(automation.id);
      setAutomations((current) =>
        current.map((entry) =>
          entry.id === automation.id
            ? beginAutomationRun(entry, { runId, threadId: thread.id }, now, scheduled)
            : entry,
        ),
      );
      void chatRef.current.send(thread.id, automation.instructions);
    },
    [locale],
  );

  // The background service ran automations while no window was open: each
  // finished run becomes an unread thread here and a line in the history.
  const importBackgroundRuns = useCallback(async () => {
    if (!hasDesktopBackend()) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const records =
        (await invoke<BackgroundRunRecord[] | undefined>("agent_automations_take_runs")) ?? [];
      for (const record of records) {
        const automation = automationsRef.current.find(
          (entry) => entry.id === record.automationId,
        );
        const thread = chatRef.current.importRecordedTurn(
          {
            definitionId: record.definitionId,
            workingDirectory: record.workingDirectory,
            permission: record.permission,
            model: record.model,
            title: runTitle(
              { name: automation?.name ?? record.automationName },
              new Date(record.startedAt),
              locale,
            ),
            automationId: record.automationId,
            activate: false,
          },
          record.turnId,
          record.instructions,
          record.events,
          record.startedAt,
        );
        setAutomations((current) =>
          current.map((entry) =>
            entry.id === record.automationId
              ? recordBackgroundRun(entry, record, thread.id)
              : entry,
          ),
        );
      }
    } catch {
      // No background service: nothing to take in.
    }
  }, [locale]);

  // The service gets the whole list whenever it changes and answers with
  // its own marks, which win where it got further than this window.
  const syncBackground = useCallback(async () => {
    if (!hasDesktopBackend()) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const statuses =
        (await invoke<AutomationStatusRecord[] | undefined>("agent_automations_sync", {
          automations: automationsRef.current,
        })) ?? [];
      backgroundRunning.current = new Set(
        statuses.filter((status) => status.running).map((status) => status.id),
      );
      setAutomations((current) => mergeBackgroundStatus(current, statuses));
    } catch {
      // Without the service the window keeps running automations alone.
    }
  }, []);

  const tick = useCallback(() => {
    if (!hasDesktopBackend() || !backgroundReady.current) return;
    const current = automationsRef.current;
    for (const id of inFlight.current) {
      const entry = current.find((automation) => automation.id === id);
      if (!entry || isAutomationRunning(entry)) inFlight.current.delete(id);
    }
    const reserved = inFlight.current.size + backgroundRunning.current.size;
    for (const automation of dueAutomations(current, Date.now(), reserved)) {
      if (inFlight.current.has(automation.id)) continue;
      if (backgroundRunning.current.has(automation.id)) continue;
      start(automation, true);
    }
  }, [start]);

  // The clock. Only the desktop backend can run a CLI, so the browser
  // preview never ticks. What the service did while no window was open is
  // taken in first, so this window never re-runs an automation the service
  // already ran; a change to the list is checked at once rather than at
  // the next half minute.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await importBackgroundRuns();
      await syncBackground();
      if (cancelled) return;
      backgroundReady.current = true;
      tick();
    })();
    const timer = setInterval(() => {
      void importBackgroundRuns().then(syncBackground).then(tick);
    }, TICK_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [importBackgroundRuns, syncBackground, tick]);

  useEffect(() => {
    void syncBackground();
    tick();
  }, [automations, syncBackground, tick]);

  // A run ends when its thread's turn does. The thread's last item says
  // how; the thread is then news until someone opens it.
  useEffect(() => {
    for (const automation of automationsRef.current) {
      if (!isAutomationRunning(automation)) continue;
      for (const run of automation.runs) {
        if (run.outcome !== "running") continue;
        const thread = chat.threads.find((entry) => entry.id === run.threadId);
        if (!thread) {
          setAutomations((current) =>
            current.map((entry) =>
              entry.id === automation.id
                ? finishAutomationRun(entry, run.runId, "stopped", null)
                : entry,
            ),
          );
          continue;
        }
        if (thread.runningTurnId !== null) continue;
        const last = thread.items[thread.items.length - 1];
        if (!last || last.type !== "turnEnd") continue;
        const outcome = last.error === null ? "ok" : "error";
        setAutomations((current) =>
          triggerDependents(
            current.map((entry) =>
              entry.id === automation.id
                ? finishAutomationRun(entry, run.runId, outcome, last.error)
                : entry,
            ),
            automation.id,
            outcome,
          ),
        );
        if (chat.activeThreadId !== thread.id) chat.markUnread(thread.id, true);
      }
    }
  }, [chat]);

  const create = useCallback((draft: AutomationDraft) => {
    const automation = createAutomation(draft);
    setAutomations((current) => [automation, ...current]);
    return automation;
  }, []);

  const update = useCallback((id: string, draft: AutomationDraft) => {
    setAutomations((current) =>
      current.map((entry) => (entry.id === id ? updateAutomation(entry, draft) : entry)),
    );
  }, []);

  const setEnabled = useCallback((id: string, enabled: boolean) => {
    setAutomations((current) =>
      current.map((entry) => (entry.id === id ? setAutomationEnabled(entry, enabled) : entry)),
    );
  }, []);

  const remove = useCallback((id: string) => {
    setAutomations((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const runNow = useCallback(
    (id: string) => {
      const automation = automationsRef.current.find((entry) => entry.id === id);
      if (!automation || isAutomationRunning(automation)) return;
      start(automation, false);
    },
    [start],
  );

  const unreadCount = useMemo(
    () => chat.threads.filter((thread) => thread.automationId !== null && thread.unread).length,
    [chat.threads],
  );

  return useMemo(
    () => ({ automations, create, update, setEnabled, remove, runNow, unreadCount }),
    [automations, create, update, setEnabled, remove, runNow, unreadCount],
  );
}
