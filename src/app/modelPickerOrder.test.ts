import { describe, expect, it } from "vitest";
import { groupPickerModels } from "./modelPickerOrder";

const ids = (values: string[]) => values.map(id => ({ id, ownedBy: "antigravity" }));
const order = (values: string[]) => groupPickerModels(ids(values), model => model).flatMap(group => group.models.map(model => model.id));

describe("model picker ordering", () => {
  it("groups makers alphabetically even when they share a proxy channel", () => {
    const input = ids(["gpt-6-mini", "gemini-3-flash", "claude-sonnet-4", "gpt-6-pro"]);
    const original = [...input];
    const groups = groupPickerModels(input, model => model);
    expect(groups.map(group => group.brand)).toEqual(["Anthropic", "Google", "OpenAI"]);
    expect(groups[2].models.map(model => model.id)).toEqual(["gpt-6-pro", "gpt-6-mini"]);
    expect(input).toEqual(original);
  });

  it("puts product tiers before generations, then compares versions numerically", () => {
    expect(order(["claude-haiku-5", "claude-sonnet-4.10", "claude-opus-4-5", "claude-sonnet-4.9"])).toEqual([
      "claude-opus-4-5", "claude-sonnet-4.10", "claude-sonnet-4.9", "claude-haiku-5",
    ]);
    expect(order(["gemini-4-flash-lite", "gemini-4-flash", "gemini-3-pro", "gemini-3.16-pro", "gemini-3.9-pro"])).toEqual([
      "gemini-3.16-pro", "gemini-3.9-pro", "gemini-3-pro", "gemini-4-flash", "gemini-4-flash-lite",
    ]);
    expect(order(["gpt-6-nano", "gpt-6-mini", "gpt-5-pro", "gpt-6", "gpt-image-9"])).toEqual([
      "gpt-5-pro", "gpt-6", "gpt-6-mini", "gpt-6-nano", "gpt-image-9",
    ]);
  });

  it("recognizes native aliases and does not mistake snapshots for model versions", () => {
    expect(order(["haiku", "sonnet", "opus"])).toEqual(["opus", "sonnet", "haiku"]);
    expect(order(["models/claude-opus-4-20250514", "claude-opus-4-5", "claude-opus-4.10"])).toEqual([
      "claude-opus-4.10", "claude-opus-4-5", "models/claude-opus-4-20250514",
    ]);
  });

  it("keeps full model identity and stable ties, with unclassified models last", () => {
    const input = [{ id: "custom", ownedBy: null, account: "first" },
      { id: "gpt-6-astra", ownedBy: null, account: "second" },
      { id: "gpt-6-sol", ownedBy: null, account: "third" }];
    const groups = groupPickerModels(input, model => model);
    expect(groups.map(group => group.brand)).toEqual(["OpenAI", null]);
    expect(groups[0].models).toEqual([input[1], input[2]]);
    expect(groups[0].models[0]).toBe(input[1]);
  });
});
