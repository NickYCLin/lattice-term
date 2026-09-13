import { PathDropZone } from "../files/PathDropZone";
/**
 * Scheduled automations: the editor for one, and its run history.
 *
 * Each run is an ordinary chat thread; this pane only owns the schedule and
 * the list of runs, and hands off to the thread for the actual reading.
 */

import { useState, type FormEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  automationLimits,
  chainReaches,
  draftFromAutomation,
  emptyAutomationDraft,
  isAutomationRunning,
  validateAutomationDraft,
  type Automation,
  type AutomationDraft,
  type AutomationErrors,
  type AutomationRun,
  type AutomationSchedule,
} from "../../app/agentAutomations";
import {
  chatPermissions,
  type ChatDefinitionId,
  type ChatModelList,
  type ChatPermission,
} from "../../app/agentChat";
import { ModelField } from "./ModelField";
import type { AgentAutomationsApi } from "../../app/useAgentAutomations";
import { displayPath } from "../../app/displayPath";
import { useI18n } from "../../i18n/context";
import type { MessageKey } from "../../i18n/messages/zh-TW";
import { Callout } from "../common/Callout";
import { ConfirmDialog } from "../overlays/ConfirmDialog";
import { FolderIcon, PlayIcon, TrashIcon } from "../icons";

const permissionLabelKey: Record<ChatPermission, MessageKey> = {
  ask: "chat.permission.ask",
  readOnly: "chat.permission.readOnly",
  workspaceWrite: "chat.permission.workspaceWrite",
  full: "chat.permission.full",
};

const weekdayKeys: MessageKey[] = [
  "automation.weekday.0",
  "automation.weekday.1",
  "automation.weekday.2",
  "automation.weekday.3",
  "automation.weekday.4",
  "automation.weekday.5",
  "automation.weekday.6",
];

const errorKey: Record<string, MessageKey> = {
  "name.required": "automation.error.nameRequired",
  "name.tooLong": "automation.error.nameTooLong",
  "instructions.required": "automation.error.instructionsRequired",
  "instructions.tooLong": "automation.error.instructionsTooLong",
  "workingDirectory.required": "automation.error.directoryRequired",
  "permission.unattended": "automation.error.unattended",
  "time.invalid": "automation.error.time",
  "weekdays.invalid": "automation.error.weekdays",
  "everyMinutes.range": "automation.error.interval",
  "after.required": "automation.error.afterRequired",
  "after.missing": "automation.error.afterMissing",
  "after.cycle": "automation.error.afterCycle",
};

/** The schedule in words, for the list and the detail header. */
export function describeSchedule(
  schedule: AutomationSchedule,
  t: (key: MessageKey, values?: Record<string, string | number>) => string,
  automations: readonly Automation[] = [],
): string {
  if (schedule.kind === "after") {
    const source = automations.find((entry) => entry.id === schedule.automationId);
    const name = source?.name ?? t("automation.after.missing");
    return t(schedule.onlyOnSuccess ? "automation.after.success" : "automation.after.any", {
      name,
    });
  }
  if (schedule.kind === "interval") {
    const minutes = schedule.everyMinutes;
    if (minutes % 1440 === 0) return t("automation.every.days", { count: minutes / 1440 });
    if (minutes % 60 === 0) return t("automation.every.hours", { count: minutes / 60 });
    return t("automation.every.minutes", { count: minutes });
  }
  const days = [...schedule.weekdays].sort();
  const weekdays = [1, 2, 3, 4, 5];
  const label =
    days.length === 0 || days.length === 7
      ? t("automation.daily")
      : days.length === 5 && weekdays.every((day) => days.includes(day))
        ? t("automation.weekdays")
        : days.map((day) => t(weekdayKeys[day])).join("、");
  return t("automation.at", { days: label, time: schedule.time });
}

export function AutomationPane({
  automations,
  selectedId,
  editing,
  defaults,
  installed,
  cliLabel,
  onSelect,
  onDoneEditing,
  onOpenThread,
  models,
  loadModels,
}: {
  automations: AgentAutomationsApi;
  models: Record<ChatDefinitionId, ChatModelList>;
  loadModels: (definitionId: ChatDefinitionId) => void;
  selectedId: string | null;
  /** True for a brand-new automation being composed. */
  editing: boolean;
  defaults: Partial<AutomationDraft>;
  installed: readonly ChatDefinitionId[];
  cliLabel: (id: ChatDefinitionId) => string;
  onSelect: (id: string | null) => void;
  onDoneEditing: () => void;
  onOpenThread: (threadId: string) => void;
}) {
  const { t, tag } = useI18n();
  const selected = automations.automations.find((entry) => entry.id === selectedId) ?? null;
  const [editingExisting, setEditingExisting] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Automation | null>(null);

  if (editing || (selected && editingExisting)) {
    const initial = selected && editingExisting ? draftFromAutomation(selected) : emptyAutomationDraft(defaults);
    return (
      <AutomationForm
        key={selected && editingExisting ? selected.id : "new"}
        initial={initial}
        others={automations.automations}
        selfId={selected && editingExisting ? selected.id : null}
        installed={installed}
        cliLabel={cliLabel}
        models={models}
        loadModels={loadModels}
        onCancel={() => {
          setEditingExisting(false);
          onDoneEditing();
        }}
        onSave={(draft) => {
          if (selected && editingExisting) {
            automations.update(selected.id, draft);
            setEditingExisting(false);
          } else {
            const created = automations.create(draft);
            onSelect(created.id);
          }
          onDoneEditing();
        }}
      />
    );
  }

  if (!selected) return null;
  const running = isAutomationRunning(selected);

  return (
    <>
      <header className="chat-header">
        <div className="chat-header__title">
          <h2>{selected.name}</h2>
          <p className="automation-background-hint">{t("automation.background.hint")}</p>
          <div className="chat-composer__actions">
            <button
              type="button"
              className="button button--primary button--sm"
              onClick={() => automations.runNow(selected.id)}
              disabled={running || !installed.includes(selected.definitionId)}
            >
              <PlayIcon />
              {running ? t("automation.running") : t("automation.runNow")}
            </button>
            <button
              type="button"
              className="button button--secondary button--sm"
              onClick={() => automations.setEnabled(selected.id, !selected.enabled)}
            >
              {selected.enabled ? t("automation.pause") : t("automation.resume")}
            </button>
            <button
              type="button"
              className="button button--secondary button--sm"
              onClick={() => setEditingExisting(true)}
            >
              {t("common.edit")}
            </button>
            <button
              type="button"
              className="button button--ghost button--danger button--sm"
              onClick={() => setPendingDelete(selected)}
              aria-label={t("automation.delete")}
              title={t("automation.delete")}
            >
              <TrashIcon />
            </button>
          </div>
        </div>
        <p className="chat-composer__hint">
          {describeSchedule(selected.schedule, t, automations.automations)} ·{" "}
          {cliLabel(selected.definitionId)} ·{" "}
          {t(permissionLabelKey[selected.permission])} ·{" "}
          <span title={selected.workingDirectory}>{displayPath(selected.workingDirectory)}</span>
        </p>
        <p className="chat-composer__hint">
          {!selected.enabled
            ? t("automation.paused")
            : selected.nextRunAt !== null
              ? t("automation.next", { at: new Date(selected.nextRunAt).toLocaleString(tag) })
              : selected.schedule.kind === "after"
                ? t("automation.waiting", {
                    name:
                      automations.automations.find(
                        (entry) =>
                          selected.schedule.kind === "after" &&
                          entry.id === selected.schedule.automationId,
                      )?.name ?? t("automation.after.missing"),
                  })
                : t("automation.paused")}
        </p>
        {!installed.includes(selected.definitionId) && (
          <Callout tone="warn">
            {t("chat.notInstalled", { cli: cliLabel(selected.definitionId) })}
          </Callout>
        )}
      </header>
      <div className="chat-messages">
        <div className="chat-messages__inner">
          <details className="chat-card chat-card--reasoning" open>
            <summary>
              <span className="chat-card__label">{t("automation.instructions")}</span>
            </summary>
            <p className="chat-card__text">{selected.instructions}</p>
          </details>
          <h3 className="automation-runs__title">{t("automation.runs")}</h3>
          {selected.runs.length === 0 ? (
            <p className="chat-notice">{t("automation.runs.none")}</p>
          ) : (
            <ul className="automation-runs">
              {selected.runs.map((run) => (
                <li key={run.runId}>
                  <RunRow run={run} onOpen={() => onOpenThread(run.threadId)} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {pendingDelete && (
        <ConfirmDialog
          title={t("automation.delete.confirm.title", { name: pendingDelete.name })}
          body={t("automation.delete.confirm.body")}
          confirmLabel={t("automation.delete.confirm.action")}
          tone="danger"
          onConfirm={() => {
            automations.remove(pendingDelete.id);
            setPendingDelete(null);
            onSelect(null);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </>
  );
}

function RunRow({ run, onOpen }: { run: AutomationRun; onOpen: () => void }) {
  const { t, tag } = useI18n();
  const outcomeKey: Record<AutomationRun["outcome"], MessageKey> = {
    running: "automation.run.running",
    ok: "automation.run.ok",
    error: "automation.run.error",
    stopped: "automation.run.stopped",
  };
  return (
    <button type="button" className={`automation-run automation-run--${run.outcome}`} onClick={onOpen}>
      <span className="automation-run__time">{new Date(run.startedAt).toLocaleString(tag)}</span>
      <span className="automation-run__outcome">{t(outcomeKey[run.outcome])}</span>
      {run.error && <span className="automation-run__error">{run.error}</span>}
    </button>
  );
}

function AutomationForm({
  initial,
  others,
  selfId,
  installed,
  cliLabel,
  models,
  loadModels,
  onSave,
  onCancel,
}: {
  initial: AutomationDraft;
  others: readonly Automation[];
  selfId: string | null;
  installed: readonly ChatDefinitionId[];
  cliLabel: (id: ChatDefinitionId) => string;
  models: Record<ChatDefinitionId, ChatModelList>;
  loadModels: (definitionId: ChatDefinitionId) => void;
  onSave: (draft: AutomationDraft) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<AutomationDraft>(initial);
  const [errors, setErrors] = useState<AutomationErrors>({});
  const [notice, setNotice] = useState<string | null>(null);
  const cliChoices = installed.length > 0 ? installed : [draft.definitionId];

  function patch(update: Partial<AutomationDraft>) {
    setDraft((current) => ({ ...current, ...update }));
  }

  function message(field: keyof AutomationErrors): string | null {
    const code = errors[field];
    if (!code) return null;
    const key = errorKey[`${field}.${code}`];
    return key ? t(key) : code;
  }

  async function chooseDirectory() {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t("chat.directory.choose"),
      });
      if (typeof selected === "string") patch({ workingDirectory: selected });
    } catch (reason) {
      setNotice(
        t("chat.directory.chooseFailed", {
          detail: reason instanceof Error ? reason.message : String(reason),
        }),
      );
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const found = validateAutomationDraft(draft, others, selfId);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    onSave(draft);
  }

  const schedule = draft.schedule;
  const intervalUnit =
    schedule.kind === "interval" && schedule.everyMinutes % 60 === 0 ? "hours" : "minutes";
  // Only sources that would not close a loop are offered.
  const chainSources = others.filter(
    (entry) => entry.id !== selfId && !(selfId && chainReaches(others, entry.id, selfId)),
  );

  return (
    <form className="automation-form" onSubmit={submit}>
      <div className="chat-header">
        <div className="chat-header__title">
          <h2>{t("automation.form.title")}</h2>
        </div>
      </div>
      <div className="chat-messages">
        <div className="chat-messages__inner automation-form__fields">
          <label className="field">
            <span className="field__label">{t("automation.name")}</span>
            <input
              className={`input${errors.name ? " is-invalid" : ""}`}
              value={draft.name}
              maxLength={automationLimits.nameLength}
              onChange={(event) => patch({ name: event.target.value })}
            />
            {message("name") && <span className="field__error">{message("name")}</span>}
          </label>
          <label className="field">
            <span className="field__label">{t("automation.instructions")}</span>
            <textarea
              className={`input${errors.instructions ? " is-invalid" : ""}`}
              rows={5}
              value={draft.instructions}
              placeholder={t("automation.instructions.placeholder")}
              onChange={(event) => patch({ instructions: event.target.value })}
            />
            {message("instructions") && (
              <span className="field__error">{message("instructions")}</span>
            )}
          </label>
          <div className="chat-settings">
            <ModelField
              definitionId={draft.definitionId}
              definitionIds={cliChoices}
              cliLabel={cliLabel}
              value={draft.model}
              models={models}
              loadModels={loadModels}
              onChange={({ definitionId, model }) => patch({ definitionId, model })}
            />
            <div className="field field--grow">
              <span className="field__label">{t("chat.directory")}</span>
              <PathDropZone kind="directory" onSelect={path => patch({ workingDirectory: path })}>
              <div className="chat-directory">
                <button
                  type="button"
                  className="button button--secondary button--sm"
                  onClick={chooseDirectory}
                >
                  <FolderIcon />
                  {t("chat.directory.choose")}
                </button>
                <span className="chat-directory__path" title={draft.workingDirectory}>
                  {draft.workingDirectory
                    ? displayPath(draft.workingDirectory)
                    : t("chat.directory.none")}
                </span>
              </div>
              </PathDropZone>
              {message("workingDirectory") && (
                <span className="field__error">{message("workingDirectory")}</span>
              )}
            </div>
            <label className="field">
              <span className="field__label">{t("chat.permission")}</span>
              <select
                className="select"
                value={draft.permission}
                onChange={(event) => patch({ permission: event.target.value as ChatPermission })}
              >
                {chatPermissions
                  .filter((permission) => permission !== "ask")
                  .map((permission) => (
                    <option key={permission} value={permission}>
                      {t(permissionLabelKey[permission])}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <p className="chat-composer__hint">{t("automation.permission.hint")}</p>

          <fieldset className="automation-schedule">
            <legend className="field__label">{t("automation.schedule")}</legend>
            <div className="automation-schedule__kind" role="radiogroup">
              <label>
                <input
                  type="radio"
                  name="schedule-kind"
                  checked={schedule.kind === "daily"}
                  onChange={() =>
                    patch({ schedule: { kind: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] } })
                  }
                />
                {t("automation.schedule.daily")}
              </label>
              <label>
                <input
                  type="radio"
                  name="schedule-kind"
                  checked={schedule.kind === "interval"}
                  onChange={() => patch({ schedule: { kind: "interval", everyMinutes: 60 } })}
                />
                {t("automation.schedule.interval")}
              </label>
              <label>
                <input
                  type="radio"
                  name="schedule-kind"
                  checked={schedule.kind === "after"}
                  disabled={chainSources.length === 0}
                  onChange={() =>
                    patch({
                      schedule: {
                        kind: "after",
                        automationId: chainSources[0]?.id ?? "",
                        onlyOnSuccess: true,
                      },
                    })
                  }
                />
                {t("automation.schedule.after")}
              </label>
            </div>
            {schedule.kind === "after" ? (
              <div className="automation-schedule__interval">
                <label className="field">
                  <span className="field__label">{t("automation.after.source")}</span>
                  <select
                    className={`select${errors.after ? " is-invalid" : ""}`}
                    value={schedule.automationId}
                    onChange={(event) =>
                      patch({ schedule: { ...schedule, automationId: event.target.value } })
                    }
                  >
                    {chainSources.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="automation-schedule__day">
                  <input
                    type="checkbox"
                    checked={schedule.onlyOnSuccess}
                    onChange={(event) =>
                      patch({ schedule: { ...schedule, onlyOnSuccess: event.target.checked } })
                    }
                  />
                  {t("automation.after.onlyOnSuccess")}
                </label>
                {message("after") && <span className="field__error">{message("after")}</span>}
              </div>
            ) : schedule.kind === "daily" ? (
              <div className="automation-schedule__daily">
                <label className="field">
                  <span className="field__label">{t("automation.time")}</span>
                  <input
                    className={`input${errors.time ? " is-invalid" : ""}`}
                    type="time"
                    value={schedule.time}
                    onChange={(event) =>
                      patch({ schedule: { ...schedule, time: event.target.value } })
                    }
                  />
                  {message("time") && <span className="field__error">{message("time")}</span>}
                </label>
                <div className="field">
                  <span className="field__label">{t("automation.days")}</span>
                  <div className="automation-schedule__days">
                    {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                      <label key={day} className="automation-schedule__day">
                        <input
                          type="checkbox"
                          checked={schedule.weekdays.length === 0 || schedule.weekdays.includes(day)}
                          onChange={(event) => {
                            const current =
                              schedule.weekdays.length === 0 ? [0, 1, 2, 3, 4, 5, 6] : schedule.weekdays;
                            const next = event.target.checked
                              ? [...new Set([...current, day])]
                              : current.filter((entry) => entry !== day);
                            patch({ schedule: { ...schedule, weekdays: next } });
                          }}
                        />
                        {t(weekdayKeys[day])}
                      </label>
                    ))}
                    <button
                      type="button"
                      className="button button--ghost button--sm"
                      onClick={() => patch({ schedule: { ...schedule, weekdays: [1, 2, 3, 4, 5] } })}
                    >
                      {t("automation.weekdays")}
                    </button>
                    <button
                      type="button"
                      className="button button--ghost button--sm"
                      onClick={() => patch({ schedule: { ...schedule, weekdays: [] } })}
                    >
                      {t("automation.daily")}
                    </button>
                  </div>
                  {message("weekdays") && (
                    <span className="field__error">{message("weekdays")}</span>
                  )}
                </div>
              </div>
            ) : (
              <div className="automation-schedule__interval">
                <label className="field">
                  <span className="field__label">{t("automation.every")}</span>
                  <input
                    className={`input${errors.everyMinutes ? " is-invalid" : ""}`}
                    type="number"
                    min={1}
                    value={intervalUnit === "hours" ? schedule.everyMinutes / 60 : schedule.everyMinutes}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      patch({
                        schedule: {
                          kind: "interval",
                          everyMinutes: intervalUnit === "hours" ? value * 60 : value,
                        },
                      });
                    }}
                  />
                </label>
                <label className="field">
                  <span className="field__label">{t("automation.unit")}</span>
                  <select
                    className="select"
                    value={intervalUnit}
                    onChange={(event) => {
                      const hours = event.target.value === "hours";
                      const count = Math.max(
                        1,
                        Math.round(
                          intervalUnit === "hours" ? schedule.everyMinutes / 60 : schedule.everyMinutes,
                        ),
                      );
                      patch({
                        schedule: { kind: "interval", everyMinutes: hours ? count * 60 : count },
                      });
                    }}
                  >
                    <option value="minutes">{t("automation.unit.minutes")}</option>
                    <option value="hours">{t("automation.unit.hours")}</option>
                  </select>
                </label>
                {message("everyMinutes") && (
                  <span className="field__error">{message("everyMinutes")}</span>
                )}
              </div>
            )}
          </fieldset>
          <p className="chat-composer__hint">
            {t("automation.schedule.hint")}{" "}
            {t("automation.concurrency.hint", { count: automationLimits.maxConcurrentRuns })}
          </p>
          {message("permission") && <Callout tone="danger">{message("permission")}</Callout>}
          {notice && <Callout tone="danger">{notice}</Callout>}
        </div>
      </div>
      <div className="chat-composer">
        <div className="chat-composer__box">
          <div className="chat-composer__row">
            <span className="chat-composer__hint">{t("automation.storage.note")}</span>
            <div className="chat-composer__actions">
              <button type="button" className="button button--secondary button--sm" onClick={onCancel}>
                {t("common.cancel")}
              </button>
              <button type="submit" className="button button--primary button--sm">
                {t("common.save")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}
