import { describe, expect, it } from "vitest";
import { herdrAgentKey, herdrCanPrompt, type HerdrAgent } from "./herdr";

const agent: HerdrAgent = { pane_id: "w1:p1", terminal_id: "term-1", agent: "codex", name: null,
  title: null, cwd: null, agent_status: "idle", interactive_ready: true };

describe("Herdr prompt guards", () => {
  it("accepts ready agents without treating text as a command", () => {
    expect(herdrCanPrompt(agent, "保留 & 檢查原始檔")).toBe(true);
    expect(herdrCanPrompt({ ...agent, agent_status: "done" }, "繼續")).toBe(true);
  });
  it.each(["working", "blocked", "unknown"])("rejects %s agents", agent_status => {
    expect(herdrCanPrompt({ ...agent, agent_status }, "繼續")).toBe(false);
  });
  it("requires readiness and bounded single-line input", () => {
    expect(herdrCanPrompt(null, "繼續")).toBe(false);
    expect(herdrCanPrompt({ ...agent, interactive_ready: false }, "繼續")).toBe(false);
    for (const text of ["", " ", "a\nb", "a\tb", "a\u001bb", "a\u0085b", "中".repeat(5334)]) {
      expect(herdrCanPrompt(agent, text)).toBe(false);
    }
    expect(herdrCanPrompt(agent, "x".repeat(16000))).toBe(true);
  });
  it("distinguishes replacement terminals in the same pane", () => {
    expect(herdrAgentKey(agent)).not.toBe(herdrAgentKey({ ...agent, terminal_id: "term-2" }));
  });
});
