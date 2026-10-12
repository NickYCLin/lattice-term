import { describe, expect, it } from "vitest";
import {
  createSessionClosedNotice,
  isSuccessfulProcessExit,
  reconcileSessionSnapshot,
  reconcileSingletonSnapshot,
  snapshotHydrationMap,
  snapshotSessionIds,
  shouldClearSessionSelection,
} from "./sessionSnapshot";

describe("isSuccessfulProcessExit", () => {
  it("distinguishes a clean CLI exit from an interrupted session", () => {
    expect(
      isSuccessfulProcessExit(
        "Process exited: ExitStatus { code: 0, signal: None }",
      ),
    ).toBe(true);
    expect(
      isSuccessfulProcessExit(
        "Process exited: ExitStatus { code: 1, signal: None }",
      ),
    ).toBe(false);
    expect(isSuccessfulProcessExit("Connection reset")).toBe(false);
    expect(isSuccessfulProcessExit("exit status 0")).toBe(true);
    expect(isSuccessfulProcessExit("exit status 1")).toBe(false);
    expect(isSuccessfulProcessExit("exit status 01")).toBe(false);
    expect(isSuccessfulProcessExit("SSH transport error: exit status 0")).toBe(false);
  });
});

interface TestSession {
  sessionId: string;
  revision: number;
}

describe("shouldClearSessionSelection", () => {
  it("clears the selection when the visible session closes", () => {
    expect(shouldClearSessionSelection("ssh-active", "ssh-active")).toBe(true);
  });

  it("keeps the visible selection when a background session closes", () => {
    expect(
      shouldClearSessionSelection("ssh-active", "agent-background"),
    ).toBe(false);
  });
});

describe("createSessionClosedNotice", () => {
  it("keeps a readable close notice after the matching pane is removed", () => {
    const sessions = [{ sessionId: "agent-1", label: "Review agent" }];

    expect(
      createSessionClosedNotice(
        sessions,
        "agent-1",
        "Process exited: 1",
        (session) => session.label,
        42,
      ),
    ).toEqual({
      sessionId: "agent-1",
      label: "Review agent",
      reason: "Process exited: 1",
      at: 42,
    });
  });

  it("falls back to the id when a close races the initial snapshot", () => {
    expect(
      createSessionClosedNotice(
        [],
        "ssh-early-close",
        "Connection lost",
        () => "unused",
        43,
      ).label,
    ).toBe("ssh-early-close");
  });
});

describe("hydration snapshots", () => {
  it("remain stable when React runs an updater after buffers are cleared", () => {
    const closedBuffer = new Set(["closed"]);
    const stateBuffer = new Map([["working", 2]]);
    const closedSnapshot = snapshotSessionIds(closedBuffer);
    const stateSnapshot = snapshotHydrationMap(stateBuffer);
    const deferredUpdater = () => ({
      sessions: reconcileSessionSnapshot<TestSession>(
        [],
        [
          { sessionId: "open", revision: 1 },
          { sessionId: "closed", revision: 1 },
        ],
        closedSnapshot,
      ),
      workingRevision: stateSnapshot.get("working"),
    });

    closedBuffer.clear();
    stateBuffer.clear();

    expect(deferredUpdater()).toEqual({
      sessions: [{ sessionId: "open", revision: 1 }],
      workingRevision: 2,
    });
  });
});

describe("reconcileSessionSnapshot", () => {
  it("restores backend sessions and keeps newer local state", () => {
    const result = reconcileSessionSnapshot<TestSession>(
      [
        { sessionId: "shared", revision: 2 },
        { sessionId: "connected-later", revision: 1 },
      ],
      [
        { sessionId: "snapshot-only", revision: 1 },
        { sessionId: "shared", revision: 1 },
      ],
    );

    expect(result).toEqual([
      { sessionId: "snapshot-only", revision: 1 },
      { sessionId: "shared", revision: 2 },
      { sessionId: "connected-later", revision: 1 },
    ]);
  });

  it("does not resurrect a session closed while the snapshot was loading", () => {
    const result = reconcileSessionSnapshot<TestSession>(
      [],
      [
        { sessionId: "still-open", revision: 1 },
        { sessionId: "closed", revision: 1 },
      ],
      new Set(["closed"]),
    );

    expect(result).toEqual([{ sessionId: "still-open", revision: 1 }]);
  });
});

describe("reconcileSingletonSnapshot", () => {
  const identity = (session: TestSession) => session.sessionId;

  it("keeps a newer status event instead of an older backend snapshot", () => {
    expect(
      reconcileSingletonSnapshot(
        { sessionId: "host-current", revision: 2 },
        { sessionId: "host-current", revision: 1 },
        identity,
      ),
    ).toEqual({ sessionId: "host-current", revision: 2 });
  });

  it("does not restore a host closed while the snapshot was loading", () => {
    expect(
      reconcileSingletonSnapshot(
        null,
        { sessionId: "host-closed", revision: 1 },
        identity,
        new Set(["host-closed"]),
      ),
    ).toBeNull();
  });

  it("still restores an unrelated current backend host", () => {
    expect(
      reconcileSingletonSnapshot(
        null,
        { sessionId: "host-new", revision: 1 },
        identity,
        new Set(["host-old"]),
      ),
    ).toEqual({ sessionId: "host-new", revision: 1 });
  });
});
