import type { ChatThread } from "./agentChat";
export interface ContextUsage { tokensUsed: number; contextWindow: number | null }
export interface RateLimitWindow { key: string; label: string; usedPercent: number; windowMinutes: number | null; resetsAt: number | null }
export interface PlanStep { text: string; status: "pending" | "inProgress" | "completed" }
export interface GoalState { objective: string; status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete"; tokensUsed: number; tokenBudget: number | null; timeUsedSeconds: number }
export interface RuntimeStatus {
  identity: string;
  observedAt: number;
  contextUsage?: ContextUsage;
  rateLimits?: RateLimitWindow[];
}
export function runtimeIdentity(thread: Pick<ChatThread, "definitionId" | "provider" | "proxyId" | "accountProfileId" | "workingDirectory" | "model" | "nativeSessionId">): string {
  return JSON.stringify([thread.definitionId, thread.provider, thread.proxyId, thread.accountProfileId, thread.workingDirectory, thread.model, thread.nativeSessionId]);
}
export function currentRuntimeStatus(thread: ChatThread): RuntimeStatus | undefined {
  return thread.runtimeStatus?.identity === runtimeIdentity(thread) ? thread.runtimeStatus : undefined;
}
export function validPlanSteps(value: unknown): value is PlanStep[] {
  return Array.isArray(value) && value.length <= 64 && value.every(step => step && typeof step.text === "string"
    && step.text.length <= 1100 && ["pending", "inProgress", "completed"].includes(step.status));
}
export function validGoal(value: unknown): value is GoalState {
  if (!value || typeof value !== "object") return false;
  const goal = value as GoalState;
  return typeof goal.objective === "string" && goal.objective.length <= 4200
    && ["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"].includes(goal.status)
    && Number.isSafeInteger(goal.tokensUsed) && goal.tokensUsed >= 0
    && Number.isSafeInteger(goal.timeUsedSeconds) && goal.timeUsedSeconds >= 0
    && (goal.tokenBudget === null || (Number.isSafeInteger(goal.tokenBudget) && goal.tokenBudget >= 0));
}
