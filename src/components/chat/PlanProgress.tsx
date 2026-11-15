import type { GoalState, PlanStep } from "../../app/chatRuntimeStatus";
import { useI18n } from "../../i18n/context";
export function PlanProgress({ steps, explanation, compact = false }: {
  steps: readonly PlanStep[]; explanation?: string | null; compact?: boolean;
}) {
  const { t } = useI18n();
  if (!steps.length && !explanation) return null;
  const completed = steps.filter(step => step.status === "completed").length;
  const active = steps.find(step => step.status === "inProgress");
  return <details className={`chat-plan${compact ? " is-compact" : ""}`} open={compact ? undefined : true}>
    <summary><strong>{t("chat.plan.title")}</strong><span>{completed}/{steps.length}</span>{active && <span className="chat-plan__active">{active.text}</span>}
      {steps.length > 0 && <progress value={completed} max={steps.length} aria-label={t("chat.plan.title")} />}
    </summary>
    {explanation && <p>{explanation}</p>}
    <ol>{steps.map((step, index) => <li key={index} className={`is-${step.status}`}><span aria-label={t(`chat.plan.${step.status}`)}>{step.status === "completed" ? "✓" : step.status === "inProgress" ? "→" : "○"}</span>{step.text}</li>)}</ol>
  </details>;
}
export function GoalProgress({ goal, compact = false }: { goal: GoalState | null; compact?: boolean }) {
  const { t } = useI18n();
  if (!goal) return null;
  return <details open={compact ? undefined : true} className={`chat-goal is-${goal.status}${compact ? " is-compact" : ""}`} aria-label={t("chat.goal.title")}>
    <summary><strong>{t("chat.goal.title")}</strong><span>{t(`chat.goal.${goal.status}`)}</span><span className="chat-goal__objective">{goal.objective}</span></summary>
    {goal.tokenBudget !== null && <div>{t("chat.goal.budget", { used: goal.tokensUsed.toLocaleString(), budget: goal.tokenBudget.toLocaleString() })}
      {goal.tokenBudget > 0 && <progress max={goal.tokenBudget} value={Math.min(goal.tokensUsed, goal.tokenBudget)} aria-label={t("chat.goal.budgetLabel")} />}</div>}
  </details>;
}
