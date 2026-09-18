import { describe, expect, it, vi } from "vitest";
import {
  CLI_PROXY_SETTINGS_KEY,
  cliProxyLaunchArguments,
  cliProxyConfigured,
  cliProxyMessageKey,
  cliProxyModelLabel,
  cliProxyStatusCode,
  emptyCliProxySettings,
  groupCliProxyModels,
  loadCliProxySettings,
  saveCliProxySettings,
} from "./cliProxyApi";

const reader = (raw: string | null) => ({ getItem: () => raw });

describe("cliProxyApi settings", () => {
  it("keeps a trimmed address and treats anything unusable as unset", () => {
    expect(loadCliProxySettings(reader(JSON.stringify({ baseUrl: " http://127.0.0.1:8317 " })))).toEqual({
      baseUrl: "http://127.0.0.1:8317",
    });
    for (const raw of [null, "not json", "[]", "{}", JSON.stringify({ baseUrl: "   " }), JSON.stringify({ baseUrl: 7 })]) {
      expect(loadCliProxySettings(reader(raw)), raw ?? "null").toEqual(emptyCliProxySettings);
    }
    expect(loadCliProxySettings(reader(JSON.stringify({ baseUrl: `http://${"h".repeat(300)}` })))).toEqual(
      emptyCliProxySettings,
    );
  });

  it("removes the entry instead of storing a blank address", () => {
    const setItem = vi.fn();
    const removeItem = vi.fn();
    saveCliProxySettings({ setItem, removeItem }, { baseUrl: " http://localhost:8317 " });
    expect(setItem).toHaveBeenCalledWith(CLI_PROXY_SETTINGS_KEY, JSON.stringify({ baseUrl: "http://localhost:8317" }));

    saveCliProxySettings({ setItem, removeItem }, { baseUrl: "  " });
    expect(removeItem).toHaveBeenCalledWith(CLI_PROXY_SETTINGS_KEY);
  });

  it("knows when a proxy has been set up", () => {
    expect(cliProxyConfigured({ baseUrl: "http://127.0.0.1:8317" })).toBe(true);
    expect(cliProxyConfigured({ baseUrl: " " })).toBe(false);
  });
});

describe("cliProxyApi messages", () => {
  it("translates known refusals and leaves transport errors alone", () => {
    expect(cliProxyMessageKey("cliproxy.url.scheme")).toBe("cliproxy.url.scheme");
    expect(cliProxyMessageKey("cliproxy.models.unauthorized")).toBe("cliproxy.models.unauthorized");
    expect(cliProxyMessageKey("error sending request for url (http://127.0.0.1:8317/healthz)")).toBeNull();
    expect(cliProxyMessageKey("cliproxy.models.status:503")).toBeNull();
  });

  it("reads the proxy's own status code back out", () => {
    expect(cliProxyStatusCode("cliproxy.models.status:503")).toBe(503);
    expect(cliProxyStatusCode("cliproxy.models.status:4030")).toBeNull();
    expect(cliProxyStatusCode("cliproxy.models.unauthorized")).toBeNull();
  });

  it("names the provider next to the model when the proxy reports one", () => {
    expect(cliProxyModelLabel({ id: "gpt-5.6-sol", ownedBy: "openai" })).toBe("gpt-5.6-sol · openai");
    expect(cliProxyModelLabel({ id: "gpt-5.6-sol", ownedBy: null })).toBe("gpt-5.6-sol");
  });
});

describe("cliProxyApi model grouping", () => {
  it("keeps one brand together regardless of case and sorts it strongest first", () => {
    const groups = groupCliProxyModels([
      { id: "gpt-image-2.5-flare", ownedBy: "openai" },
      { id: "claude-haiku-4.5", ownedBy: "anthropic" },
      { id: "gpt-5.6-sol", ownedBy: "OpenAI" },
      { id: "claude-opus-5", ownedBy: "anthropic" },
      { id: "gpt-6-astra", ownedBy: "openai" },
    ]);
    expect(groups.map((group) => group.brand)).toEqual(["openai", "anthropic"]);
    expect(groups[0].models.map((model) => model.id)).toEqual([
      "gpt-6-astra", "gpt-5.6-sol", "gpt-image-2.5-flare",
    ]);
    expect(groups[1].models.map((model) => model.id)).toEqual(["claude-opus-5", "claude-haiku-4.5"]);
  });

  it("reads dotted versions numerically, not as text", () => {
    const [group] = groupCliProxyModels([
      { id: "gemini-3.9-pro", ownedBy: "google" },
      { id: "gemini-3.16-pro", ownedBy: "google" },
    ]);
    expect(group.models.map((model) => model.id)).toEqual(["gemini-3.16-pro", "gemini-3.9-pro"]);
  });

  it("parks unversioned models and unbranded models at the end", () => {
    const groups = groupCliProxyModels([
      { id: "mystery", ownedBy: null },
      { id: "gemini-embedding", ownedBy: "google" },
      { id: "gemini-3-flash", ownedBy: "google" },
    ]);
    expect(groups.map((group) => group.brand)).toEqual(["google", null]);
    expect(groups[0].models.map((model) => model.id)).toEqual(["gemini-3-flash", "gemini-embedding"]);
    expect(groups[1].models.map((model) => model.id)).toEqual(["mystery"]);
  });
});

describe("proxy launch metadata", () => {
  it("keeps reverse proxy prefixes and refuses missing setup", () => {
    expect(cliProxyLaunchArguments(" https://proxy.example/prefix/ ")).toEqual([
      "-c", "model_provider=latticeterm_cliproxyapi", "-c",
      'model_providers.latticeterm_cliproxyapi.base_url="https://proxy.example/prefix/v1"',
    ]);
    expect(() => cliProxyLaunchArguments(" ")).toThrow("cliproxy.url.empty");
  });
});
