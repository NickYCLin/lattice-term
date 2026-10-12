import { describe, expect, it, vi } from "vitest";
import { fakeSession } from "./testFixtures/agentApis";
import type { AgentSessionSummary } from "./useAgentSessions";
import type { SavedAgentSession } from "./workspaceSessionPersistence";
import { createWorkspaceSessionStartup, remainingWorkspaceSessions } from "./workspaceSessionStartup";

const saved: SavedAgentSession = {
  kind: "agent", groupKey: "project-one", groupLabel: "Project",
  definitionId: "codex", label: "Codex", executable: "codex",
  launchArguments: [], workingDirectory: "/work", resumeSessionId: "thread-one",
};

function pendingLaunch() {
  let resolve!: (session: AgentSessionSummary) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<AgentSessionSummary>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("workspace conversation startup", () => {
  it("does not put a successfully retried conversation back into the failed list", () => {
    const other = { ...saved, groupKey: "other" };
    expect(remainingWorkspaceSessions([saved, other], [other])).toEqual([other]);
  });

  it("preserves unsuccessful retries and SSH failures when restoration finishes", () => {
    const ssh = { kind: "ssh" as const, profileId: "ssh-fixture" };
    expect(remainingWorkspaceSessions([saved, ssh], [saved, ssh])).toEqual([saved, ssh]);
  });

  it("does not restore an entry the user discarded during startup", () => {
    expect(remainingWorkspaceSessions([saved], [])).toEqual([]);
  });

  it("starts a selected conversation without waiting for an unrelated restore", async () => {
    const startup = createWorkspaceSessionStartup();
    const slow = pendingLaunch();
    const restoring = startup.start(saved, () => slow.promise);
    const launch = vi.fn(async () => fakeSession({ sessionId: "selected" }));
    expect((await startup.start({ ...saved, groupKey: "selected" }, launch)).sessionId)
      .toBe("selected");
    expect(launch).toHaveBeenCalledOnce();
    slow.resolve(fakeSession());
    await restoring;
  });

  it("joins the same in-flight launch when a saved conversation is clicked repeatedly", async () => {
    const startup = createWorkspaceSessionStartup();
    const pending = pendingLaunch();
    const launch = vi.fn(() => pending.promise);
    const first = startup.start(saved, launch);
    const second = startup.start({ ...saved }, launch);
    expect(second).toBe(first);
    pending.resolve(fakeSession());
    await Promise.all([first, second]);
    expect(launch).toHaveBeenCalledOnce();
  });

  it("reattaches a manually started conversation when the automatic loop reaches it later", async () => {
    const startup = createWorkspaceSessionStartup();
    const launch = vi.fn(async () => fakeSession());
    const manual = await startup.start(saved, launch);
    expect(await startup.start({ ...saved }, launch)).toBe(manual);
    expect(launch).toHaveBeenCalledOnce();
  });

  it.each([
    { groupKey: "different-tab" }, { definitionId: "claude" },
    { profileConfigPath: "/account-two" }, { workingDirectory: "/other" },
    { resumeSessionId: "thread-two" }, { executable: "other-cli" },
    { launchArguments: ["--model", "other-model"] }, { detached: true }, { sandbox: true },
  ])("does not merge distinct launch intents: %j", async changes => {
    const startup = createWorkspaceSessionStartup();
    const launch = vi.fn(async () => fakeSession());
    await startup.start(saved, launch);
    await startup.start({ ...saved, ...changes }, launch);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("allows a failed launch to be explicitly retried", async () => {
    const startup = createWorkspaceSessionStartup();
    const launch = vi.fn().mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce(fakeSession());
    await expect(startup.start(saved, launch)).rejects.toThrow("unavailable");
    await expect(startup.start(saved, launch)).resolves.toMatchObject({ sessionId: "s1" });
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("does not cache a process that exited during startup", async () => {
    const startup = createWorkspaceSessionStartup();
    const launch = vi.fn().mockResolvedValueOnce(fakeSession({ closedReason: "exited" }))
      .mockResolvedValueOnce(fakeSession());
    await startup.start(saved, launch);
    expect((await startup.start(saved, launch)).closedReason).toBeUndefined();
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("permits another launch after restoration completes instead of retaining a stale result", async () => {
    const startup = createWorkspaceSessionStartup();
    const launch = vi.fn(async () => fakeSession());
    await startup.start(saved, launch);
    startup.completeRestoration();
    await startup.start(saved, launch);
    await startup.start(saved, launch);
    expect(launch).toHaveBeenCalledTimes(3);
  });

  it("keeps a pending launch deduplicated across restoration completion", async () => {
    const startup = createWorkspaceSessionStartup();
    const pending = pendingLaunch();
    const launch = vi.fn(() => pending.promise);
    const first = startup.start(saved, launch);
    startup.completeRestoration();
    expect(startup.start(saved, launch)).toBe(first);
    pending.resolve(fakeSession());
    await first;
    await startup.start(saved, launch);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("releases a synchronously failed launch", async () => {
    const startup = createWorkspaceSessionStartup();
    const launch = vi.fn(() => { throw new Error("not ready"); });
    await expect(startup.start(saved, launch)).rejects.toThrow("not ready");
    await expect(startup.start(saved, async () => fakeSession())).resolves.toBeDefined();
  });
});
