import { expect, it } from "vitest";
import { defaultPreferences, sanitizePreferences } from "./preferences";
import { fakeSession } from "./testFixtures/agentApis";
import { applyAgentStateEvent } from "./useAgentSessions";
it("defaults to two minutes and permits disabling but rejects invalid durations", () => {
  expect(defaultPreferences.codexHandoffMinutes).toBe(2);
  expect(sanitizePreferences({ codexHandoffMinutes: 0 }).codexHandoffMinutes).toBe(0);
  expect(sanitizePreferences({ codexHandoffMinutes: -5 }).codexHandoffMinutes).toBe(2);
});
it("updates the shared lifecycle snapshot on release and reacquisition", () => {
  const original = fakeSession();
  const [released] = applyAgentStateEvent([original], { sessionId: original.sessionId, state: "idle", source: "integration", writerReleased: true, processId: null });
  expect(released.writerReleased).toBe(true); expect(released.processId).toBeNull();
  const [resumed] = applyAgentStateEvent([released], { sessionId: original.sessionId, state: "idle", source: "heuristic", writerReleased: false, processId: 1234 });
  expect(resumed.writerReleased).toBe(false); expect(resumed.capturedSessionId).toBe(original.capturedSessionId);
});
