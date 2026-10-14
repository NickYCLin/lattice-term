import { describe, expect, it } from "vitest";
import {
  aggregateSessionSidebarStatus,
  agentGroupSidebarStatus,
  anyAgentSessionJustCompleted,
} from "./sessionStatus";

describe("agent group sidebar status", () => {
  it("aggregates visible project and folder status by urgency", () => {
    expect(aggregateSessionSidebarStatus(["done", "working"])).toBe("working");
    expect(aggregateSessionSidebarStatus(["done", "attention"])).toBe(
      "attention",
    );
    expect(aggregateSessionSidebarStatus(["done", "done"])).toBe("done");
    expect(aggregateSessionSidebarStatus(["connected"])).toBe("connected");
  });

  it("prioritizes attention and only marks the whole group done when all members finish", () => {
    expect(agentGroupSidebarStatus([{ state: "working" }, { state: "done" }])).toBe(
      "working",
    );
    expect(
      agentGroupSidebarStatus([{ state: "needsAttention" }, { state: "done" }]),
    ).toBe("attention");
    expect(agentGroupSidebarStatus([{ state: "done" }, { state: "done" }])).toBe(
      "done",
    );
  });

  it("notifies when any CLI in a grouped tab finishes", () => {
    const previous = new Map([
      ["codex", "working" as const],
      ["gemini", "working" as const],
    ]);

    expect(
      anyAgentSessionJustCompleted(previous, [
        { sessionId: "codex", state: "done" },
        { sessionId: "gemini", state: "working" },
      ]),
    ).toBe(true);
    expect(
      anyAgentSessionJustCompleted(null, [
        { sessionId: "codex", state: "done" },
      ]),
    ).toBe(false);
  });

  it("does not announce closed processes or newly discovered historical tasks", () => {
    const previous = new Map([["synthetic", "working" as const]]);
    expect(anyAgentSessionJustCompleted(previous, [
      { sessionId: "synthetic", state: "done", closedReason: "Synthetic process cancelled" },
    ])).toBe(false);
    expect(anyAgentSessionJustCompleted(previous, [
      { sessionId: "historical", state: "done" },
    ])).toBe(false);
    expect(anyAgentSessionJustCompleted(previous, [
      { sessionId: "synthetic", state: "needsAttention" },
    ])).toBe(false);
  });
});
