import { expect, it } from "vitest";
import { fakeSession } from "./testFixtures/agentApis";
import {
  USER_EXITED_REASON,
  agentSessionEndedByUser,
  agentSessionHasEnded,
  resumeAgentSessionRequest,
} from "./agentSessionResume";

it("treats a released or closed process as ended, but not a running session", () => {
  expect(agentSessionHasEnded(fakeSession({ processId: 12, writerReleased: false }))).toBe(false);
  expect(agentSessionHasEnded(fakeSession({ processId: null, writerReleased: true }))).toBe(true);
  expect(agentSessionHasEnded(fakeSession({ processId: 12, closedReason: "Process exited: 1" }))).toBe(true);
  expect(agentSessionEndedByUser(fakeSession({ closedReason: USER_EXITED_REASON }))).toBe(true);
  expect(agentSessionEndedByUser(fakeSession({ closedReason: "Process exited: 0" }))).toBe(false);
});

it("resumes the captured conversation in the same cwd without replaying a seed", () => {
  const session = fakeSession({
    capturedSessionId: "native-thread",
    workingDirectory: "/work/dfm",
    launchArguments: ["--ask-for-approval", "never"],
    groupId: "group-1",
    profileConfigPath: "/tmp/profile",
  });
  expect(resumeAgentSessionRequest({ ...session, capturedSessionId: null })).toBeNull();
  expect(resumeAgentSessionRequest(session)).toEqual({
    definitionId: session.definitionId,
    label: session.label,
    executable: session.executable,
    arguments: ["--ask-for-approval", "never"],
    resumeSessionId: "native-thread",
    groupId: "group-1",
    seedInput: null,
    restoreExistingSession: true,
    profileConfigPath: "/tmp/profile",
    sandbox: session.sandboxed,
    detached: session.detached,
    workingDirectory: "/work/dfm",
    cols: 120,
    rows: 32,
  });
});
