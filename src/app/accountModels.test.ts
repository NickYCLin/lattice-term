import { describe, expect, it } from "vitest";
import { accountModelKey, accountModelLaunchSettings, accountModelOptions, accountModelTargetKey, accountModelTargets, accountSessionLabel, hasChatModels, validCliProxyModel } from "./accountModels";
import { cliProxyLaunchArguments, type CliProxyEndpoint } from "./cliProxyApi";
import { fakeDefinition } from "./testFixtures/agentApis";
import { selectThreadModel } from "./agentChat";
import { fakeThread } from "./testFixtures/agentApis";

const profile = { id: "b", definitionId: "codex" as const, name: "B 帳號", configDirectory: "/profiles/b" };
const definition = fakeDefinition({ account: { state: "signedIn", label: "A 帳號", method: "oauth" } });
const labels = { defaultModel: "預設模型", loading: "讀取中", signedOut: "尚未登入" };
const status = { state: "signedIn" as const, label: null, method: null };
const model = { value: "gpt-5.6", label: "GPT-5.6", description: null, isDefault: false };
const proxies: CliProxyEndpoint[] = [
  { id: "default", label: "工作代理", baseUrl: "http://localhost:8317" },
  { id: "7f3a91", label: "備援代理", baseUrl: "https://proxy.example" },
];

describe("account-aware model choices", () => {
  it("recognises all supported chat definitions including Antigravity", () => {
    expect(hasChatModels("codex")).toBe(true);
    expect(hasChatModels("claude")).toBe(true);
    expect(hasChatModels("gemini")).toBe(true);
    expect(hasChatModels("antigravity")).toBe(true);
    expect(hasChatModels("cursor")).toBe(false);
  });

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

  it("offers each proxy once and retains only the selected legacy account", () => {
    const targets = accountModelTargets([definition, fakeDefinition({ id: "claude", label: "Claude Code" })], [profile], { b: status }, "Default");
    expect(accountModelOptions(targets, {}, labels).some((option) => option.provider)).toBe(false);
    const proxyOptions = accountModelOptions(targets, {}, labels, undefined, proxies).filter((option) => option.provider);
    expect(proxyOptions).toHaveLength(2);
    expect(proxyOptions.map((option) => option.accountProfileId)).toEqual([null, null]);
    expect(proxyOptions.map((option) => option.proxyId)).toEqual(["default", "7f3a91"]);
    expect(proxyOptions.map(option => option.label)).toEqual(["工作代理", "備援代理"]);
    expect(proxyOptions.every((option) => option.definitionId === "codex")).toBe(true);
    const selection = { ...proxyOptions[0], accountProfileId: "b", model: "claude-sonnet-4-5" };
    const legacy = accountModelOptions(targets, {}, labels, selection, proxies).filter(option => option.provider);
    expect(legacy).toHaveLength(3);
    expect(accountModelKey(selection)).toBe(accountModelKey(legacy[2]));
    expect(legacy[2].label).toBe("工作代理 · B 帳號");
    expect(accountModelKey(selection)).not.toBe(accountModelKey(proxyOptions[1]));
    expect(accountModelLaunchSettings(selection, [profile], proxies)).toEqual({
      profileConfigPath: "/profiles/b", arguments: ["-c", "model_provider=latticeterm_cliproxyapi", "-c", 'model_providers.latticeterm_cliproxyapi.base_url="http://localhost:8317/v1"', "--model", "claude-sonnet-4-5"],
    });
    // A second proxy launches against its own address, under its own marker.
    expect(accountModelLaunchSettings({ ...proxyOptions[1], model: "claude-sonnet-4-5" }, [profile], proxies).arguments)
      .toEqual([...cliProxyLaunchArguments("https://proxy.example", "7f3a91"), "--model", "claude-sonnet-4-5"]);
    expect(() => accountModelLaunchSettings({ ...selection, proxyId: "removed" }, [profile], proxies)).toThrow("missing-proxy");
    expect(accountModelLaunchSettings({ ...selection, provider: undefined }, [profile]).arguments).toEqual(["--model", "claude-sonnet-4-5"]);
  });

  it("rejects empty, suspicious or unsupported proxy model selections before launch", () => {
    expect(validCliProxyModel("gpt-5.6-sol")).toBe(true);
    for (const modelId of ["", " -c", "--help", "gpt 5", "gpt\n5", "a".repeat(257)]) {
      expect(validCliProxyModel(modelId)).toBe(false);
      expect(() => accountModelLaunchSettings({ definitionId: "codex", accountProfileId: null, model: modelId, provider: "cliproxyapi" }, [])).toThrow("invalid-proxy-model");
    }
    expect(() => accountModelLaunchSettings({ definitionId: "claude", accountProfileId: null, model: "sonnet", provider: "cliproxyapi" }, [])).toThrow("unsupported-provider");
    expect(() => accountModelLaunchSettings({ definitionId: "codex", accountProfileId: "removed", model: "gpt-5.6-sol", provider: "cliproxyapi" }, [profile])).toThrow("missing-account");
  });

  it("does not require native Codex login for a proxy", () => {
    const targets = accountModelTargets([{ ...definition, account: { ...definition.account, state: "signedOut" } }], [], {}, "Default");
    const options = accountModelOptions(targets, {}, labels, undefined, proxies);
    expect(options.filter(option => !option.provider).every(option => option.disabled)).toBe(true);
    expect(options.find(option => option.provider)?.disabled).toBe(false);
    expect(options.find(option => option.provider)?.label).not.toContain(labels.signedOut);
    expect(() => accountModelLaunchSettings({ definitionId: "codex", accountProfileId: null, model: "proxy-model", provider: "cliproxyapi" }, [])).toThrow("missing-proxy");
  });

  it("resets native identity when entering or leaving the proxy, but not when changing its model", () => {
    const original = fakeThread({ nativeSessionId: "native-a", items: [{ type: "user", id: "u", text: "近期脈絡", at: 1 }] });
    const proxy = selectThreadModel(original, { definitionId: "codex", accountProfileId: null, model: "proxy-model", provider: "cliproxyapi" });
    expect(proxy.provider).toBe("cliproxyapi");
    expect(proxy.nativeSessionId).toBeNull();
    expect(proxy.handoff?.transcript).toContain("近期脈絡");
    const next = selectThreadModel({ ...proxy, nativeSessionId: "proxy-native" }, { definitionId: "codex", accountProfileId: null, model: "another-model", provider: "cliproxyapi" });
    expect(next.nativeSessionId).toBe("proxy-native");
    const native = selectThreadModel(next, { definitionId: "codex", accountProfileId: null, model: "" });
    expect(native.provider).toBeUndefined();
    expect(native.nativeSessionId).toBeNull();
  });

  it("labels running Windows sessions without changing their stored CLI name", () => {
    const targets = accountModelTargets([definition], [{ ...profile, configDirectory: "C:\\profiles\\b" }], {}, "預設帳號");
    expect(accountSessionLabel({ definitionId: "codex", label: "OpenAI Codex", profileConfigPath: "\\\\?\\C:\\profiles\\b" }, targets, "已移除")).toBe("B 帳號 · OpenAI Codex");
    expect(accountSessionLabel({ definitionId: "codex", label: "OpenAI Codex", profileConfigPath: "/missing" }, targets, "已移除")).toBe("OpenAI Codex · 已移除");
    expect(accountSessionLabel({ definitionId: "codex", label: "OpenAI Codex" }, accountModelTargets([definition], [], {}, "預設帳號"), "已移除")).toBe("OpenAI Codex");
  });

  it("names a proxy-launched session after CLIProxyAPI instead of the CLI account", () => {
    const targets = accountModelTargets([definition], [profile], { b: status }, "預設帳號");
    const launchArguments = [...cliProxyLaunchArguments("http://127.0.0.1:8317"), "--model", "claude-opus-5"];
    expect(accountSessionLabel({ definitionId: "codex", label: "OpenAI Codex", profileConfigPath: "/profiles/b", launchArguments }, targets, "已移除")).toBe("CLIProxyAPI");
    expect(accountSessionLabel({ definitionId: "codex", label: "OpenAI Codex", profileConfigPath: "/profiles/b", launchArguments: ["--model", "gpt-5.6"] }, targets, "已移除")).toBe("B 帳號 · OpenAI Codex");
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
