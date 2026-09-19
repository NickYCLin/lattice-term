import { describe, expect, it } from "vitest";
import { effortChoices, effortForTurn, type ChatModelList } from "./agentChat";

const codexModels: ChatModelList = {
  state: "ready",
  models: [
    {
      value: "gpt-5.6-sol",
      label: "Sol",
      description: null,
      isDefault: true,
      defaultEffort: "medium",
      efforts: [
        { value: "low", description: "Fast" },
        { value: "high", description: "Thorough" },
      ],
    },
    { value: "gpt-5.6-terra", label: "Terra", description: null, isDefault: false },
  ],
};

describe("reasoning effort", () => {
  it("offers Claude's fixed levels and each Codex model's own", () => {
    expect(effortChoices("claude", "", undefined).map((e) => e.value)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortChoices("codex", "", codexModels).map((e) => e.value)).toEqual(["low", "high"]);
    expect(effortChoices("codex", "gpt-5.6-terra", codexModels)).toEqual([]);
    expect(effortChoices("gemini", "", codexModels)).toEqual([]);
  });

  it("sends the chosen level, or the model's default so Codex drops an old override", () => {
    expect(effortForTurn({ definitionId: "codex", model: "", effort: "high" }, codexModels)).toBe("high");
    expect(effortForTurn({ definitionId: "codex", model: "", effort: null }, codexModels)).toBe("medium");
    // A level the current model does not offer is not sent.
    expect(effortForTurn({ definitionId: "codex", model: "", effort: "max" }, codexModels)).toBe("medium");
    expect(effortForTurn({ definitionId: "claude", model: "", effort: "xhigh" }, undefined)).toBe("xhigh");
    expect(effortForTurn({ definitionId: "claude", model: "", effort: null }, undefined)).toBeNull();
    expect(effortForTurn({ definitionId: "gemini", model: "", effort: "high" }, undefined)).toBeNull();
  });
});
