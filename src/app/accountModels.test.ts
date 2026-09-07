import { describe, expect, it } from "vitest";
import { accountModelKey, accountModelLaunchSettings, accountModelOptions, accountModelTargetKey, accountModelTargets, accountSessionLabel } from "./accountModels";
import { fakeDefinition } from "./testFixtures/agentApis";
import { selectThreadModel } from "./agentChat";
import { fakeThread } from "./testFixtures/agentApis";

const profile = { id: "b", definitionId: "codex" as const, name: "B 帳號", configDirectory: "/profiles/b" };
const definition = fakeDefinition({ account: { state: "signedIn", label: "A 帳號", method: "oauth" } });
const labels = { defaultModel: "預設模型", loading: "讀取中", signedOut: "尚未登入" };
const status = { state: "signedIn" as const, label: null, method: null };
const model = { value: "gpt-5.6", label: "GPT-5.6", description: null, isDefault: false };

describe("account-aware model choices", () => {
  it("omits account labels for a sole account, independently for each CLI", () => {
    const targets = accountModelTargets([definition, fakeDefinition({ id: "claude", label: "Claude Code" })], [], {}, "預設帳號");
    expect(targets.every((target) => !target.showAccount)).toBe(true);
    expect(accountModelOptions(targets, {}, labels).map((option) => option.label)).toEqual([
      "OpenAI Codex · 預設模型", "Claude Code · 預設模型",
    ]);
  });

  it("omits the name when only a named profile is signed in", () => {
    const targets = accountModelTargets([fakeDefinition({ account: { state: "signedOut", label: null, method: null } })], [profile], { b: status }, "預設帳號");
    const options = accountModelOptions(targets, {}, labels);
    expect(options.find((option) => option.accountProfileId === "b")?.label).toBe("OpenAI Codex · 預設模型");
    expect(options.find((option) => option.accountProfileId === null)?.disabled).toBe(true);
  });

  it("distinguishes identical models from A and B using only each account's discovery", () => {
    const targets = accountModelTargets([definition], [profile], { b: status }, "預設帳號");
    const lists = Object.fromEntries(targets.map((target) => [accountModelTargetKey(target), {
      state: "ready" as const, models: target.accountProfileId ? [model] : [model, { ...model, value: "a-only", label: "A 專屬模型" }],
    }]));
    const options = accountModelOptions(targets, lists, labels);
    const shared = options.filter((option) => option.model === model.value);
    expect(shared.map((option) => option.label)).toEqual(["A 帳號 · OpenAI Codex · GPT-5.6", "B 帳號 · OpenAI Codex · GPT-5.6"]);
    expect(new Set(shared.map(accountModelKey)).size).toBe(2);
    expect(options.some((option) => option.accountProfileId === "b" && option.model === "a-only")).toBe(false);
    expect(accountModelLaunchSettings(shared[1], [profile])).toEqual({ profileConfigPath: "/profiles/b", arguments: ["--model", "gpt-5.6"] });
    expect(accountModelLaunchSettings(shared[0], [profile]).profileConfigPath).toBeNull();
  });

  it("does not borrow another account's list while discovery is unavailable", () => {
    const targets = accountModelTargets([definition], [profile], {}, "預設帳號");
    const options = accountModelOptions(targets, { [accountModelTargetKey(targets[0])]: { state: "ready", models: [model] } }, labels);
    expect(options.filter((option) => option.accountProfileId === "b").map((option) => option.model)).toEqual([""]);
    expect(() => accountModelLaunchSettings({ definitionId: "codex", accountProfileId: "deleted", model: "" }, [profile])).toThrow("missing-account");
    expect(() => accountModelLaunchSettings({ definitionId: "claude", accountProfileId: "b", model: "" }, [profile])).toThrow("missing-account");
  });

  it("labels running Windows sessions without changing their stored CLI name", () => {
    const targets = accountModelTargets([definition], [{ ...profile, configDirectory: "C:\\profiles\\b" }], {}, "預設帳號");
    expect(accountSessionLabel({ definitionId: "codex", label: "OpenAI Codex", profileConfigPath: "\\\\?\\C:\\profiles\\b" }, targets, "已移除")).toBe("B 帳號 · OpenAI Codex");
    expect(accountSessionLabel({ definitionId: "codex", label: "OpenAI Codex", profileConfigPath: "/missing" }, targets, "已移除")).toBe("OpenAI Codex · 已移除");
    expect(accountSessionLabel({ definitionId: "codex", label: "OpenAI Codex" }, accountModelTargets([definition], [], {}, "預設帳號"), "已移除")).toBe("OpenAI Codex");
  });

  it("atomically changes account/model without reusing the native conversation", () => {
    const original = fakeThread({ nativeSessionId: "native-a", items: [{ type: "user", id: "u", text: "前一段", at: 1 }] });
    const changed = selectThreadModel(original, { definitionId: "codex", accountProfileId: "b", model: "gpt-5.6" }, 2);
    expect(changed.accountProfileId).toBe("b");
    expect(changed.nativeSessionId).toBeNull();
    expect(changed.items).toEqual(original.items);
    expect(changed.handoff?.transcript).toContain("前一段");
    const modelOnly = selectThreadModel(original, { definitionId: "codex", accountProfileId: null, model: "gpt-5.6" });
    expect(modelOnly.nativeSessionId).toBe("native-a");
    const providerChange = selectThreadModel(changed, { definitionId: "claude", accountProfileId: null, model: "sonnet" });
    expect(providerChange.accountProfileId).toBeNull();
    expect(providerChange.nativeSessionId).toBeNull();
    const running = { ...original, runningTurnId: "busy" };
    expect(selectThreadModel(running, { definitionId: "codex", accountProfileId: "b", model: "" })).toBe(running);
  });
});
