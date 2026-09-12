import { describe, expect, it } from "vitest";
import { commandActive, newerCommand, type RemoteCommandView } from "./useRemoteCommand";
const view: RemoteCommandView = { sessionId: "test", id: 1, revision: 4, shell: "cmd", command: "echo test", directory: "C:\\test", state: "exited", stdout: "test", stderr: "", exitCode: 0, detail: "" };
describe("remote command result ordering", () => {
  it("retains a completed response when a late start reply or snapshot arrives", () => {
    expect(newerCommand(view, { ...view, revision: 0, state: "starting" })).toBe(view);
    const next = { ...view, id: 2, revision: 0, state: "starting" as const };
    expect(newerCommand(view, next)).toBe(next);
    expect(newerCommand(next, view)).toBe(next);
  });
  it("keeps cancellation pending until a terminal result arrives", () => {
    expect(commandActive({ ...view, state: "cancelling" })).toBe(true);
    for (const state of ["exited", "cancelled", "timedOut", "outputLimit", "failed"] as const) {
      expect(commandActive({ ...view, state })).toBe(false);
    }
  });
});
