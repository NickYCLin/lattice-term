/**
 * Scheduled chat runs, modelled on the Codex app's Automations: a name, the
 * instructions to send, a project, a CLI, and a schedule. Each run opens a
 * fresh chat thread so the result is reviewed like any other conversation,
 * and the thread list works as the inbox.
 *
 * Runs happen only while LatticeTerm is open: there is no daemon, so a
 * schedule that fell due while the app was closed runs once at the next
 * start and then continues from there. Unattended runs never use the
 * ask-each-time permission, because nobody is there to answer.
 *
 * An automation can also be chained after another one instead of having a
 * time of its own: when the source's run ends (or ends well), the dependent
 * becomes due. Chains form a graph that must stay acyclic, and every start
 * is subject to one concurrency cap so a fan-out cannot launch a dozen
 * assistants at once; what does not fit waits its turn.
 *
 * Pure rules only; `useAgentAutomations` wires them to the clock and to
 * chat mode.
 */

import type { ChatDefinitionId, ChatEvent, ChatPermission } from "./agentChat";

export type AutomationSchedule =
  | {
      kind: "daily";
      /** Local wall-clock time, `HH:MM`. */
      time: string;
      /** Days of the week as `Date.getDay()` numbers; empty means every day. */
      weekdays: number[];
    }
  | { kind: "interval"; everyMinutes: number }
  | {
      /** Runs when another automation's run ends. */
      kind: "after";
      automationId: string;
      /** Only follow a run that completed without error. */
      onlyOnSuccess: boolean;
    };

export type AutomationRunOutcome = "running" | "ok" | "error" | "stopped";

export interface AutomationRun {
  runId: string;
  threadId: string;
  startedAt: number;
  finishedAt: number | null;
  outcome: AutomationRunOutcome;
  error: string | null;
}

export interface Automation {
  id: string;
  name: string;
  instructions: string;
  definitionId: ChatDefinitionId;
  workingDirectory: string;
  permission: ChatPermission;
  model: string;
  schedule: AutomationSchedule;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  /** Next due time, or null while paused. A chained automation has one
   *  only between its source finishing and its own start. */
  nextRunAt: number | null;
  lastRunAt: number | null;
  /** Most recent runs, newest first. */
  runs: AutomationRun[];
}

/** A run the background service finished while no window was open. */
export interface BackgroundRunRecord {
  runId: string;
  automationId: string;
  automationName: string;
  threadId: string;
  turnId: string;
  definitionId: ChatDefinitionId;
  workingDirectory: string;
  permission: ChatPermission;
  model: string;
  instructions: string;
  startedAt: number;
  finishedAt: number | null;
  outcome: "running" | "ok" | "error";
  error: string | null;
  events: ChatEvent[];
}

/** The background service's clock marks for one automation. */
export interface AutomationStatusRecord {
  id: string;
  nextRunAt: number | null;
  lastRunAt: number | null;
  running: boolean;
}

export type AutomationDraft = Pick<
  Automation,
  | "name"
  | "instructions"
  | "definitionId"
  | "workingDirectory"
  | "permission"
  | "model"
  | "schedule"
>;

export const automationLimits = {
  nameLength: 60,
  instructionsBytes: 8 * 1024,
  minIntervalMinutes: 15,
  maxIntervalMinutes: 7 * 24 * 60,
  runsKept: 20,
  count: 50,
  /** Runs allowed at once across all automations; the rest wait. */
  maxConcurrentRuns: 2,
} as const;

export type AutomationField =
  | "name"
  | "instructions"
  | "workingDirectory"
  | "permission"
  | "time"
  | "weekdays"
  | "everyMinutes"
  | "after";

export type AutomationErrors = Partial<Record<AutomationField, string>>;

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * @param others every existing automation, so a chain can be checked for a
 *   missing source or a cycle.
 * @param selfId the automation being edited, if any; it cannot follow itself.
 */
export function validateAutomationDraft(
  draft: AutomationDraft,
  others: readonly Automation[] = [],
  selfId: string | null = null,
): AutomationErrors {
  const errors: AutomationErrors = {};
  const name = draft.name.trim();
  if (!name) errors.name = "required";
  else if (name.length > automationLimits.nameLength) errors.name = "tooLong";

  const instructions = draft.instructions.trim();
  if (!instructions) errors.instructions = "required";
  else if (new TextEncoder().encode(instructions).length > automationLimits.instructionsBytes) {
    errors.instructions = "tooLong";
  }

  if (!draft.workingDirectory.trim()) errors.workingDirectory = "required";
  // Nobody is there to answer a prompt in an unattended run.
  if (draft.permission === "ask") errors.permission = "unattended";

  if (draft.schedule.kind === "daily") {
    if (!TIME.test(draft.schedule.time)) errors.time = "invalid";
    if (draft.schedule.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
      errors.weekdays = "invalid";
    }
  } else if (draft.schedule.kind === "after") {
    const sourceId = draft.schedule.automationId;
    if (!sourceId) errors.after = "required";
    else if (sourceId === selfId) errors.after = "cycle";
    else if (!others.some((entry) => entry.id === sourceId)) errors.after = "missing";
    else if (selfId && chainReaches(others, sourceId, selfId)) errors.after = "cycle";
  } else {
    const minutes = draft.schedule.everyMinutes;
    if (
      !Number.isInteger(minutes) ||
      minutes < automationLimits.minIntervalMinutes ||
      minutes > automationLimits.maxIntervalMinutes
    ) {
      errors.everyMinutes = "range";
    }
  }
  return errors;
}

/**
 * Whether following the `after` links from `fromId` ever arrives at
 * `targetId`. Used to keep the chain graph acyclic: a cycle would make two
 * automations trigger each other forever.
 */
export function chainReaches(
  automations: readonly Automation[],
  fromId: string,
  targetId: string,
): boolean {
  const visited = new Set<string>();
  let cursor: string | null = fromId;
  while (cursor && !visited.has(cursor)) {
    if (cursor === targetId) return true;
    visited.add(cursor);
    const entry = automations.find((automation) => automation.id === cursor);
    cursor = entry?.schedule.kind === "after" ? entry.schedule.automationId : null;
  }
  return false;
}

/**
 * The first time the schedule fires strictly after `after`, in local time,
 * or null for a chained automation, which has no time of its own. A daily
 * schedule scans at most eight days ahead, which always contains one
 * allowed weekday.
 */
export function nextRunAfter(schedule: AutomationSchedule, after: Date): Date | null {
  if (schedule.kind === "after") return null;
  if (schedule.kind === "interval") {
    return new Date(after.getTime() + schedule.everyMinutes * 60_000);
  }
  const match = TIME.exec(schedule.time);
  const hours = match ? Number(match[1]) : 0;
  const minutes = match ? Number(match[2]) : 0;
  const allowed = new Set(schedule.weekdays);
  for (let offset = 0; offset <= 8; offset += 1) {
    const candidate = new Date(
      after.getFullYear(),
      after.getMonth(),
      after.getDate() + offset,
      hours,
      minutes,
      0,
      0,
    );
    if (candidate.getTime() <= after.getTime()) continue;
    if (allowed.size === 0 || allowed.has(candidate.getDay())) return candidate;
  }
  // Unreachable for a valid schedule; a full week from now is the honest
  // fallback rather than never.
  return new Date(after.getTime() + 7 * 24 * 60 * 60_000);
}

export function createAutomation(
  draft: AutomationDraft,
  id: string = crypto.randomUUID(),
  now: Date = new Date(),
): Automation {
  return {
    id,
    name: draft.name.trim(),
    instructions: draft.instructions.trim(),
    definitionId: draft.definitionId,
    workingDirectory: draft.workingDirectory.trim(),
    permission: draft.permission,
    model: draft.model.trim(),
    schedule: draft.schedule,
    enabled: true,
    createdAt: now.getTime(),
    updatedAt: now.getTime(),
    nextRunAt: plannedRun(draft.schedule, now),
    lastRunAt: null,
    runs: [],
  };
}

function plannedRun(schedule: AutomationSchedule, now: Date): number | null {
  return nextRunAfter(schedule, now)?.getTime() ?? null;
}

/** Applies an edited draft; the next run is recomputed from the new schedule. */
export function updateAutomation(
  automation: Automation,
  draft: AutomationDraft,
  now: Date = new Date(),
): Automation {
  return {
    ...automation,
    name: draft.name.trim(),
    instructions: draft.instructions.trim(),
    definitionId: draft.definitionId,
    workingDirectory: draft.workingDirectory.trim(),
    permission: draft.permission,
    model: draft.model.trim(),
    schedule: draft.schedule,
    updatedAt: now.getTime(),
    nextRunAt: automation.enabled ? plannedRun(draft.schedule, now) : null,
  };
}

export function setAutomationEnabled(
  automation: Automation,
  enabled: boolean,
  now: Date = new Date(),
): Automation {
  return {
    ...automation,
    enabled,
    updatedAt: now.getTime(),
    nextRunAt: enabled ? plannedRun(automation.schedule, now) : null,
  };
}

export function isAutomationRunning(automation: Automation): boolean {
  return automation.runs.some((run) => run.outcome === "running");
}

/**
 * Automations whose time has come, oldest due first, no more than the
 * concurrency cap leaves room for. One that is still running is skipped
 * rather than started twice; a timed one catches up at its next time, and a
 * chained one keeps its due mark until it can start.
 *
 * @param reserved starts already in flight that the caller has not yet
 *   recorded as runs, so they count against the cap too.
 */
export function dueAutomations(
  automations: Automation[],
  now: number,
  reserved = 0,
): Automation[] {
  const running = automations.filter(isAutomationRunning).length + reserved;
  const room = Math.max(0, automationLimits.maxConcurrentRuns - running);
  return automations
    .filter(
      (automation) =>
        automation.enabled &&
        automation.nextRunAt !== null &&
        automation.nextRunAt <= now &&
        !isAutomationRunning(automation),
    )
    .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))
    .slice(0, room);
}

/**
 * Marks every automation chained after `finishedId` as due, when the
 * outcome qualifies. They then start through the same clock and cap as
 * timed ones, which is what keeps a fan-out orderly.
 */
export function triggerDependents(
  automations: Automation[],
  finishedId: string,
  outcome: Exclude<AutomationRunOutcome, "running">,
  now: Date = new Date(),
): Automation[] {
  return automations.map((automation) => {
    const { schedule } = automation;
    if (
      schedule.kind !== "after" ||
      schedule.automationId !== finishedId ||
      !automation.enabled ||
      (schedule.onlyOnSuccess && outcome !== "ok") ||
      automation.nextRunAt !== null
    ) {
      return automation;
    }
    return { ...automation, nextRunAt: now.getTime(), updatedAt: now.getTime() };
  });
}

/**
 * Marks a run as started and moves the schedule past it. Called for both
 * scheduled and "run now" starts; only a scheduled start advances
 * `nextRunAt`, so running early never skips the planned time.
 */
export function beginAutomationRun(
  automation: Automation,
  run: Pick<AutomationRun, "runId" | "threadId">,
  now: Date,
  scheduled: boolean,
): Automation {
  const entry: AutomationRun = {
    runId: run.runId,
    threadId: run.threadId,
    startedAt: now.getTime(),
    finishedAt: null,
    outcome: "running",
    error: null,
  };
  return {
    ...automation,
    lastRunAt: now.getTime(),
    // A chained automation's due mark is consumed by starting; a timed one
    // moves on to its next time.
    nextRunAt:
      scheduled && automation.enabled ? plannedRun(automation.schedule, now) : automation.nextRunAt,
    runs: [entry, ...automation.runs].slice(0, automationLimits.runsKept),
    updatedAt: now.getTime(),
  };
}

export function finishAutomationRun(
  automation: Automation,
  runId: string,
  outcome: Exclude<AutomationRunOutcome, "running">,
  error: string | null,
  now: Date = new Date(),
): Automation {
  return {
    ...automation,
    runs: automation.runs.map((run) =>
      run.runId === runId && run.outcome === "running"
        ? { ...run, outcome, error, finishedAt: now.getTime() }
        : run,
    ),
    updatedAt: now.getTime(),
  };
}

/**
 * Files a run the background service completed: it appears in the history
 * like one the window ran, pointing at the thread the record was folded
 * into. Handing the same record over twice changes nothing.
 */
export function recordBackgroundRun(
  automation: Automation,
  record: BackgroundRunRecord,
  threadId: string,
  now: number = Date.now(),
): Automation {
  if (automation.runs.some((run) => run.runId === record.runId)) return automation;
  const entry: AutomationRun = {
    runId: record.runId,
    threadId,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt ?? now,
    outcome: record.outcome === "ok" ? "ok" : "error",
    error: record.error,
  };
  return {
    ...automation,
    lastRunAt: Math.max(automation.lastRunAt ?? 0, record.startedAt),
    runs: [entry, ...automation.runs]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, automationLimits.runsKept),
    updatedAt: now,
  };
}

/**
 * Takes the service's marks where it got further than the window: it ran
 * the automation while the window was closed, or made a chained one due.
 * Returns the same array when nothing changes, so callers can bail out.
 */
export function mergeBackgroundStatus(
  automations: Automation[],
  statuses: readonly AutomationStatusRecord[],
): Automation[] {
  let changed = false;
  const merged = automations.map((automation) => {
    const status = statuses.find((entry) => entry.id === automation.id);
    if (!status) return automation;
    const serviceIsNewer = (status.lastRunAt ?? 0) > (automation.lastRunAt ?? 0);
    const chainedDue =
      automation.schedule.kind === "after" &&
      automation.nextRunAt === null &&
      status.nextRunAt !== null;
    if (!serviceIsNewer && !chainedDue) return automation;
    changed = true;
    return {
      ...automation,
      lastRunAt: serviceIsNewer ? status.lastRunAt : automation.lastRunAt,
      nextRunAt: status.nextRunAt,
    };
  });
  return changed ? merged : automations;
}

/** Whatever was "running" when the app last closed cannot still be. */
export function closeStaleRuns(automation: Automation): Automation {
  if (!isAutomationRunning(automation)) return automation;
  return {
    ...automation,
    runs: automation.runs.map((run) =>
      run.outcome === "running"
        ? { ...run, outcome: "stopped", error: null, finishedAt: run.startedAt }
        : run,
    ),
  };
}

export const AUTOMATIONS_STORAGE_KEY = "latticeterm.agentAutomations.v1";
const STORAGE_KEY = AUTOMATIONS_STORAGE_KEY;

/** Fired after a backup restore rewrote the stored list, so the live one reloads. */
export const AUTOMATIONS_RESTORED_EVENT = "latticeterm:automations-restored";

function isSchedule(value: unknown): value is AutomationSchedule {
  if (!value || typeof value !== "object") return false;
  const schedule = value as Partial<AutomationSchedule> & { kind?: string };
  if (schedule.kind === "daily") {
    const weekdays = (schedule as { weekdays?: unknown }).weekdays;
    return (
      typeof (schedule as { time?: unknown }).time === "string" &&
      Array.isArray(weekdays) &&
      weekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    );
  }
  if (schedule.kind === "interval") {
    const minutes = (schedule as { everyMinutes?: unknown }).everyMinutes;
    // NaN or a fraction would make the next run NaN and the automation
    // silently never fire.
    return typeof minutes === "number" && Number.isInteger(minutes) && minutes > 0;
  }
  if (schedule.kind === "after") {
    return typeof (schedule as { automationId?: unknown }).automationId === "string";
  }
  return false;
}

function isAutomation(value: unknown): value is Automation {
  if (!value || typeof value !== "object") return false;
  const automation = value as Partial<Automation>;
  return (
    typeof automation.id === "string" &&
    typeof automation.name === "string" &&
    typeof automation.instructions === "string" &&
    (automation.definitionId === "claude" ||
      automation.definitionId === "codex" ||
      automation.definitionId === "gemini") &&
    typeof automation.workingDirectory === "string" &&
    typeof automation.permission === "string" &&
    isSchedule(automation.schedule) &&
    Array.isArray(automation.runs)
  );
}

export function loadStoredAutomations(storage: Pick<Storage, "getItem">): Automation[] {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isAutomation).slice(0, automationLimits.count).map((automation) =>
      closeStaleRuns({
        ...automation,
        model: typeof automation.model === "string" ? automation.model : "",
        enabled: automation.enabled !== false,
        createdAt: typeof automation.createdAt === "number" ? automation.createdAt : 0,
        updatedAt: typeof automation.updatedAt === "number" ? automation.updatedAt : 0,
        nextRunAt:
          typeof automation.nextRunAt === "number" && Number.isFinite(automation.nextRunAt)
            ? automation.nextRunAt
            : null,
        lastRunAt: typeof automation.lastRunAt === "number" ? automation.lastRunAt : null,
        // A stored "ask" cannot run unattended; the read-only sandbox is the
        // one choice that changes nothing without being told.
        permission: automation.permission === "ask" ? "readOnly" : automation.permission,
      }),
    );
  } catch {
    return [];
  }
}

export function saveStoredAutomations(
  storage: Pick<Storage, "setItem" | "removeItem">,
  automations: Automation[],
): void {
  try {
    if (automations.length === 0) {
      storage.removeItem(STORAGE_KEY);
      return;
    }
    storage.setItem(STORAGE_KEY, JSON.stringify(automations.slice(0, automationLimits.count)));
  } catch {
    // Storage full or unavailable: schedules still work for this session.
  }
}

export function emptyAutomationDraft(
  defaults: Partial<AutomationDraft> = {},
): AutomationDraft {
  return {
    name: "",
    instructions: "",
    definitionId: "claude",
    workingDirectory: "",
    permission: "readOnly",
    model: "",
    schedule: { kind: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] },
    ...defaults,
  };
}

export function draftFromAutomation(automation: Automation): AutomationDraft {
  return {
    name: automation.name,
    instructions: automation.instructions,
    definitionId: automation.definitionId,
    workingDirectory: automation.workingDirectory,
    permission: automation.permission,
    model: automation.model,
    schedule: automation.schedule,
  };
}
