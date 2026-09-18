import { describe, expect, it, vi } from "vitest";
import {
  CLI_PROXY_DEFAULT_ID,
  CLI_PROXY_LEGACY_SETTINGS_KEY,
  CLI_PROXY_LIMIT,
  CLI_PROXY_SETTINGS_KEY,
  cliProxyIdFromArguments,
  cliProxyLaunchArguments,
  cliProxyConfigured,
  cliProxyMessageKey,
  cliProxyModelLabel,
  cliProxyStatusCode,
  emptyCliProxySettings,
  groupCliProxyModels,
  launchedThroughCliProxy,
  loadCliProxySettings,
  saveCliProxySettings,
} from "./cliProxyApi";

const reader = (values: Record<string, string | null>) => ({
  getItem: (key: string) => values[key] ?? null,
});
const listed = (proxies: unknown) => JSON.stringify({ proxies });

describe("cliProxyApi settings", () => {
  it("keeps every usable proxy and drops the entries a picker could not use", () => {
    const stored = listed([
      { id: "default", label: " 工作代理 ", baseUrl: " http://127.0.0.1:8317 " },
      { id: "7f3a91", label: "", baseUrl: "https://proxy.example" },
      { id: "7f3a91", label: "重複", baseUrl: "https://other.example" },
      { id: "NOT-AN-ID", label: "", baseUrl: "https://proxy.example" },
      { id: "blank", label: "", baseUrl: "   " },
      { id: "toolong", label: "", baseUrl: `http://${"h".repeat(300)}` },
    ]);
    expect(loadCliProxySettings(reader({ [CLI_PROXY_SETTINGS_KEY]: stored }))).toEqual({
      proxies: [
        { id: "default", label: "工作代理", baseUrl: "http://127.0.0.1:8317" },
        { id: "7f3a91", label: "", baseUrl: "https://proxy.example" },
      ],
    });
    for (const raw of [null, "not json", "[]", "{}", listed("nope"), listed([7])]) {
      expect(loadCliProxySettings(reader({ [CLI_PROXY_SETTINGS_KEY]: raw })), raw ?? "null").toEqual(
        emptyCliProxySettings,
      );
    }
  });

  it("stops at the readable limit instead of filling the picker", () => {
    const many = Array.from({ length: CLI_PROXY_LIMIT + 3 }, (_unused, index) => ({
      id: `p${index}`, label: "", baseUrl: `http://127.0.0.1:${8317 + index}`,
    }));
    expect(loadCliProxySettings(reader({ [CLI_PROXY_SETTINGS_KEY]: listed(many) })).proxies).toHaveLength(CLI_PROXY_LIMIT);
  });

  it("carries the single proxy saved before the list existed", () => {
    expect(loadCliProxySettings(reader({
      [CLI_PROXY_LEGACY_SETTINGS_KEY]: JSON.stringify({ baseUrl: " http://127.0.0.1:8317 " }),
    }))).toEqual({
      proxies: [{ id: CLI_PROXY_DEFAULT_ID, label: "", baseUrl: "http://127.0.0.1:8317" }],
    });
    expect(loadCliProxySettings(reader({
      [CLI_PROXY_LEGACY_SETTINGS_KEY]: JSON.stringify({ baseUrl: "  " }),
    }))).toEqual(emptyCliProxySettings);
  });

  it("removes the entry instead of storing a blank address", () => {
    const setItem = vi.fn();
    const removeItem = vi.fn();
    saveCliProxySettings({ setItem, removeItem }, {
      proxies: [
        { id: "default", label: " 工作代理 ", baseUrl: " http://localhost:8317 " },
        { id: "bad id", label: "", baseUrl: "http://localhost:8318" },
      ],
    });
    expect(setItem).toHaveBeenCalledWith(CLI_PROXY_SETTINGS_KEY, listed([
      { id: "default", label: "工作代理", baseUrl: "http://localhost:8317" },
    ]));
    // The migrated copy must not resurrect a proxy that was just removed.
    expect(removeItem).toHaveBeenCalledWith(CLI_PROXY_LEGACY_SETTINGS_KEY);

    saveCliProxySettings({ setItem, removeItem }, { proxies: [] });
    expect(removeItem).toHaveBeenCalledWith(CLI_PROXY_SETTINGS_KEY);
  });

  it("knows when a proxy has been set up", () => {
    expect(cliProxyConfigured({ proxies: [{ id: "default", label: "", baseUrl: "http://127.0.0.1:8317" }] })).toBe(true);
    expect(cliProxyConfigured(emptyCliProxySettings)).toBe(false);
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
    expect(() => cliProxyLaunchArguments("http://127.0.0.1:8317", "Not An Id")).toThrow("cliproxy.id.invalid");
  });

  it("names the proxy that answers, and leaves the first one's marker alone", () => {
    // The marker written before the list existed must keep working, so an
    // already-running session still finds its key after the upgrade.
    expect(cliProxyLaunchArguments("http://127.0.0.1:8317", CLI_PROXY_DEFAULT_ID))
      .toEqual(cliProxyLaunchArguments("http://127.0.0.1:8317"));
    expect(cliProxyLaunchArguments("https://proxy.example", "7f3a91")).toEqual([
      "-c", "model_provider=latticeterm_cliproxyapi_7f3a91", "-c",
      'model_providers.latticeterm_cliproxyapi_7f3a91.base_url="https://proxy.example/v1"',
    ]);
  });
});

describe("launchedThroughCliProxy", () => {
  it("recognises the proxy provider inside stored launch arguments", () => {
    expect(launchedThroughCliProxy(cliProxyLaunchArguments("http://127.0.0.1:8317"))).toBe(true);
    expect(launchedThroughCliProxy(["--model", "gpt-5.6"])).toBe(false);
    expect(launchedThroughCliProxy(undefined)).toBe(false);
  });

  it("reports which configured proxy a saved launch belongs to", () => {
    expect(cliProxyIdFromArguments(cliProxyLaunchArguments("http://127.0.0.1:8317"))).toBe(CLI_PROXY_DEFAULT_ID);
    expect(cliProxyIdFromArguments(cliProxyLaunchArguments("https://proxy.example", "7f3a91"))).toBe("7f3a91");
    expect(cliProxyIdFromArguments(["-c", "model_provider=other"])).toBeNull();
    expect(cliProxyIdFromArguments(["model_provider=latticeterm_cliproxyapi"])).toBeNull();
  });
});
