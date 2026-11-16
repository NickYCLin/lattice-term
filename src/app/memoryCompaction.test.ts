import { expect, it, vi } from "vitest";
import { handoffSourceItems, createThread, handoffThread } from "./agentChat";
import { structureContext } from "./memoryCompaction";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
it("keeps the complete readable source beyond the old tail limit and summarizes tools separately", () => {
  const text = "public history ".repeat(5000);
  const items = handoffSourceItems([
    { type: "user", id: "u", text, at: 1 },
    {
      type: "tool",
      id: "t",
      name: "exec_command",
      summary: "read files",
      output: "exit_code: 0",
      isError: false,
      done: true,
    },
    { type: "text", id: "a", text: "Final result" },
  ]);
  expect(items[0].text).toBe(text);
  expect(items[0].text.length).toBeGreaterThan(48 * 1024);
  expect(items[1].kind).toBe("tool");
  expect(items[1].text).toContain("exit_code: 0");
  const original = {
    ...createThread(
      {
        definitionId: "codex",
        model: "",
        permission: "ask",
        workingDirectory: "/synthetic",
      },
      "synthetic-thread",
      1,
    ),
    items: [{ type: "user" as const, id: "u", text, at: 1 }],
  };
  const moved = handoffThread(original, "claude", "");
  expect(handoffSourceItems(moved.items)[0].text).toBe(text);
});
it("archives full source items instead of relying on the old short reference", async () => {
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  invoke.mockResolvedValue({ compacted: false, text: "# 結構化交接摘要" });
  const source = [
    { role: "user", kind: "", text: "Complete source", name: "" },
  ];
  await structureContext("codex", "old short tail", source);
  expect(invoke).toHaveBeenCalledWith("memory_structure_context", {
    label: "codex",
    text: "old short tail",
    sourceItems: source,
  });
  vi.unstubAllGlobals();
});
