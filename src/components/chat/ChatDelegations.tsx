import { useEffect, useState } from "react";
import {
  delegationPrompt,
  delegationResult,
  delegationState,
  type ChatDefinitionId,
  type ChatThread,
  type DelegationState,
} from "../../app/agentChat";
import { listFleetPlans, listFleetTargets, type FleetPlan, type FleetTarget } from "../../app/remoteFleet";
import type { AgentChatApi } from "../../app/useAgentChat";
import { useI18n } from "../../i18n/context";
import type { MessageKey } from "../../i18n/messages/zh-TW";

const stateKey: Record<DelegationState, MessageKey> = {
  running: "chat.delegate.state.running",
  done: "chat.delegate.state.done",
  failed: "chat.delegate.state.failed",
  waiting: "chat.delegate.state.waiting",
};

/**
 * Subtasks this conversation handed to other assistants: a form to start
 * one and the list of those running or finished, each its own conversation.
 */
export function ChatDelegations({
  thread,
  chat,
  assistants,
  cliLabel,
  composing,
  onCloseComposer,
  onInsert,
}: {
  thread: ChatThread;
  chat: AgentChatApi;
  assistants: readonly ChatDefinitionId[];
  cliLabel: (id: ChatDefinitionId) => string;
  composing: boolean;
  onCloseComposer: () => void;
  onInsert: (text: string) => void;
}) {
  const { t } = useI18n();
  const [definitionId, setDefinitionId] = useState<ChatDefinitionId>(
    assistants.find((id) => id !== thread.definitionId) ?? thread.definitionId,
  );
  const [task, setTask] = useState("");
  const [withContext, setWithContext] = useState(true);
  // "local" plus one entry per machine that shared an Agent Fleet workspace
  // this desktop may start work on.
  const [machine, setMachine] = useState("local");
  const [machines, setMachines] = useState<FleetTarget[]>([]);
  const [plans, setPlans] = useState<FleetPlan[]>([]);
  const [planId, setPlanId] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const children = chat.threads.filter((entry) => entry.delegatedFrom === thread.id);
  const target = machines.find((entry) => entry.id === machine);

  useEffect(() => {
    if (!composing) return;
    let cancelled = false;
    void listFleetTargets()
      .then((targets) => {
        if (cancelled) return;
        // Starting work there needs both: an item to start and a way to talk.
        setMachines(targets.filter((entry) => entry.connected && entry.scopes.fleetLaunch && entry.scopes.fleetControl));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [composing]);

  useEffect(() => {
    setPlans([]);
    setPlanId("");
    if (!target) return;
    let cancelled = false;
    void listFleetPlans(target.id)
      .then((found) => {
        if (cancelled) return;
        setPlans(found);
        setPlanId(found[0]?.planId ?? "");
      })
      .catch((reason: unknown) => setProblem(String(reason)));
    return () => {
      cancelled = true;
    };
  }, [target]);

  if (!composing && children.length === 0) return null;
  return (
    <section className="chat-delegations" aria-label={t("chat.delegate.title")}>
      {composing && (
        <form
          className="chat-delegations__form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!task.trim() || busy) return;
            setProblem("");
            if (!target) {
              chat.delegate(thread.id, definitionId, task, withContext);
              setTask("");
              onCloseComposer();
              return;
            }
            setBusy(true);
            void chat
              .delegateRemote(thread.id, { id: target.id, label: target.label }, planId, task, withContext)
              .then(() => {
                setTask("");
                onCloseComposer();
              })
              .catch((reason: unknown) => setProblem(String(reason)))
              .finally(() => setBusy(false));
          }}
        >
          {machines.length > 0 && (
            <label className="field">
              <span className="field__label">{t("chat.delegate.machine")}</span>
              <select className="select" value={machine} onChange={(event) => setMachine(event.target.value)}>
                <option value="local">{t("chat.delegate.machine.local")}</option>
                {machines.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {target ? (
            <label className="field">
              <span className="field__label">{t("chat.delegate.plan")}</span>
              <select className="select" value={planId} onChange={(event) => setPlanId(event.target.value)}>
                {plans.map((plan) => (
                  <option key={plan.planId} value={plan.planId}>
                    {plan.label}
                  </option>
                ))}
              </select>
              <small className="field__optional">{t("chat.delegate.plan.hint")}</small>
            </label>
          ) : (
            <label className="field">
              <span className="field__label">{t("chat.delegate.assistant")}</span>
              <select
                className="select"
                value={definitionId}
                onChange={(event) => setDefinitionId(event.target.value as ChatDefinitionId)}
              >
                {assistants.map((id) => (
                  <option key={id} value={id}>
                    {cliLabel(id)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field chat-delegations__task">
            <span className="field__label">{t("chat.delegate.task")}</span>
            <textarea
              className="input"
              rows={3}
              autoFocus
              value={task}
              maxLength={16000}
              placeholder={t("chat.delegate.placeholder")}
              onChange={(event) => setTask(event.target.value)}
            />
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={withContext} onChange={(event) => setWithContext(event.target.checked)} />
            <span className="checkbox__box" aria-hidden="true">✓</span>
            <span>{t("chat.delegate.withContext")}</span>
          </label>
          {problem && <p className="field__error">{problem}</p>}
          <div className="chat-card__actions">
            <button
              type="submit"
              className="button button--primary button--sm"
              disabled={!task.trim() || busy || (!!target && !planId)}
            >
              {t("chat.delegate.start")}
            </button>
            <button type="button" className="button button--ghost button--sm" onClick={onCloseComposer}>
              {t("common.cancel")}
            </button>
          </div>
        </form>
      )}
      {children.length > 0 && (
        <ul className="chat-delegations__list">
          {children.map((child) => {
            const state = delegationState(child);
            const result = state === "done" ? delegationResult(child) : "";
            return (
              <li key={child.id} className={`is-${state}`}>
                <span className={`chat-chip chat-delegations__state is-${state}`}>{t(stateKey[state])}</span>
                <span className="chat-delegations__title" title={child.title}>
                  {child.remote ? child.remote.targetLabel : cliLabel(child.definitionId)} ·{" "}
                  {child.title.replace(/^↳\s*/, "")}
                </span>
                <button type="button" className="button button--ghost button--sm" onClick={() => chat.setActiveThreadId(child.id)}>
                  {t("chat.delegate.open")}
                </button>
                {result && (
                  <button type="button" className="button button--secondary button--sm" onClick={() => onInsert(result)}>
                    {t("chat.delegate.bringBack")}
                  </button>
                )}
                {state === "failed" && !child.remote && (
                  <button
                    type="button"
                    className="button button--ghost button--sm"
                    onClick={() => void chat.send(child.id, delegationPrompt(child) || child.title)}
                  >
                    {t("chat.delegate.retry")}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
