import { describe, expect, it, vi } from "vitest";
import { appendBounded } from "./remoteFleet";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) =>
    command === "mcp_remote_targets"
      ? [
          { id: "a", label: "A", backend: "ssh", connected: true, scopes: { fleetObserve: true } },
          { id: "b", label: "B", backend: "ssh", connected: true, scopes: { exec: true } },
        ]
      : { result: { sessions: [{ sessionId: "s1", label: "Codex", state: "working" }] } },
  ),
}));

describe("remote Fleet", () => {
  it("keeps only the newest part of a long log", () => {
    expect(appendBounded("abc", "def", 4)).toBe("cdef");
    expect(appendBounded("a", "b")).toBe("ab");
  });

  it("offers only connections granted a Fleet scope and reads the tool result", async () => {
    const { listFleetTargets, listFleetSessions } = await import("./remoteFleet");
    expect((await listFleetTargets()).map((target) => target.id)).toEqual(["a"]);
    expect((await listFleetSessions("a"))[0].sessionId).toBe("s1");
  });
});
