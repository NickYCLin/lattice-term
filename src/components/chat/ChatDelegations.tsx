import { useState } from "react";
import {
  delegationPrompt,
  delegationResult,
  delegationState,
  type ChatDefinitionId,
  type ChatThread,
  type DelegationState,
} from "../../app/agentChat";
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
  const children = chat.threads.filter((entry) => entry.delegatedFrom === thread.id);

  if (!composing && children.length === 0) return null;
  return (
    <section className="chat-delegations" aria-label={t("chat.delegate.title")}>
      {composing && (
        <form
          className="chat-delegations__form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!task.trim()) return;
            chat.delegate(thread.id, definitionId, task, withContext);
            setTask("");
            onCloseComposer();
          }}
        >
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
          <div className="chat-card__actions">
            <button type="submit" className="button button--primary button--sm" disabled={!task.trim()}>
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
                  {cliLabel(child.definitionId)} · {child.title.replace(/^↳\s*/, "")}
                </span>
                <button type="button" className="button button--ghost button--sm" onClick={() => chat.setActiveThreadId(child.id)}>
                  {t("chat.delegate.open")}
                </button>
                {result && (
                  <button type="button" className="button button--secondary button--sm" onClick={() => onInsert(result)}>
                    {t("chat.delegate.bringBack")}
                  </button>
                )}
                {state === "failed" && (
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
