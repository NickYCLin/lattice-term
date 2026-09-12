import { describe, expect, it } from "vitest";
import {
  addExecPlan,
  clampExecTimeout,
  execPlanRequests,
  MAX_EXEC_PLANS,
  removeExecPlan,
} from "./remoteExecPlans";

const draft = (label: string) => ({ label, command: `run ${label}`, timeoutSeconds: 30 });

describe("remoteExecPlans", () => {
  it("numbers approved commands in order and renumbers after a removal", () => {
    let plans = addExecPlan(addExecPlan([], draft("build")), draft("test"));
    expect(plans.map((plan) => [plan.id, plan.label])).toEqual([
      ["command-1", "build"],
      ["command-2", "test"],
    ]);

    plans = removeExecPlan(plans, "command-1");
    expect(plans).toEqual([
      { id: "command-1", label: "test", command: "run test", timeoutSeconds: 30 },
    ]);
    // Removing something that is not there leaves the list alone.
    expect(removeExecPlan(plans, "command-9")).toBe(plans);
  });

  it("refuses empty commands and stops at the reviewable limit", () => {
    expect(addExecPlan([], { label: " ", command: "ls", timeoutSeconds: 30 })).toEqual([]);
    expect(addExecPlan([], { label: "list", command: "  ", timeoutSeconds: 30 })).toEqual([]);

    let plans: ReturnType<typeof addExecPlan> = [];
    for (let index = 0; index < MAX_EXEC_PLANS + 3; index += 1) {
      plans = addExecPlan(plans, draft(`task ${index}`));
    }
    expect(plans).toHaveLength(MAX_EXEC_PLANS);
  });

  it("keeps timeouts inside the range the backend accepts", () => {
    expect(clampExecTimeout(0)).toBe(1);
    expect(clampExecTimeout(900)).toBe(60);
    expect(clampExecTimeout(Number.NaN)).toBe(30);
    expect(clampExecTimeout(12.4)).toBe(12);
    expect(addExecPlan([], { label: "slow", command: "sleep 90", timeoutSeconds: 500 })[0]
      .timeoutSeconds).toBe(60);
  });

  it("hands the backend milliseconds and trimmed text", () => {
    const plans = addExecPlan([], { label: " build ", command: " make all ", timeoutSeconds: 5 });
    expect(execPlanRequests(plans)).toEqual([
      { id: "command-1", label: "build", command: "make all", timeoutMs: 5000 },
    ]);
  });
});
