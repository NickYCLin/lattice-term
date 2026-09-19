import { describe, expect, it } from "vitest";
import { branchThread, createThread, loadStoredThreads, type ChatThread } from "./agentChat";

function conversation(): ChatThread {
  return {
    ...createThread({ definitionId: "claude", workingDirectory: "/work", permission: "readOnly", model: "sonnet", title: "Plan the release" }, "source", 1),
    nativeSessionId: "native-1",
    items: [
      { type: "user", id: "t1:user", text: "First question" },
      { type: "text", id: "t1:answer", text: "First answer" },
      { type: "tool", id: "t1:tool", name: "Bash", summary: "ls", output: "secret.txt", isError: false, done: true },
      { type: "approval", id: "t1:approval", requestId: "r", toolUseId: null, name: "command", summary: "rm", input: "", decision: "pending" },
      { type: "user", id: "t2:user", text: "Second question" },
      { type: "text", id: "t2:answer", text: "Second answer" },
    ],
  } as ChatThread;
}

describe("branching a conversation", () => {
  it("copies up to the chosen message and starts a fresh native session", () => {
    const branch = branchThread(conversation(), "t1:approval", "(branch)", "copy", 5)!;
    expect(branch.id).toBe("copy");
    expect(branch.items.map((item) => item.id)).toEqual(["t1:user", "t1:answer", "t1:tool", "t1:approval"]);
    expect(branch.nativeSessionId).toBeNull();
    expect(branch.title).toBe("Plan the release (branch)");
    expect(branch.model).toBe("sonnet");
    expect(branch.permission).toBe("readOnly");
    // An old approval can never be answered from the copy.
    expect(branch.items[3]).toMatchObject({ decision: "closed" });
    // Only messages travel to the new session, never tool output.
    expect(branch.handoff?.transcript).toContain("First answer");
    expect(branch.handoff?.transcript).not.toContain("secret.txt");
    expect(branch.handoff?.transcript).not.toContain("Second question");
  });

  it("refuses a message that is not in the thread", () => {
    expect(branchThread(conversation(), "missing", "(branch)")).toBeNull();
  });

  it("keeps a long title within the limit", () => {
    const long = { ...conversation(), title: "x".repeat(60) };
    expect(branchThread(long, "t1:user", "(branch)")!.title.length).toBeLessThanOrEqual(60);
  });

  it("remembers that a thread was shelved", () => {
    const stored = JSON.stringify([{ ...conversation(), shelvedAt: 42 }, { ...conversation(), id: "other", shelvedAt: "bad" }]);
    const [shelved, other] = loadStoredThreads({ getItem: () => stored });
    expect(shelved.shelvedAt).toBe(42);
    expect(other.shelvedAt).toBeNull();
  });
});
