import { describe, expect, it, vi } from "vitest";
import {
  CLI_PROXY_SETTINGS_KEY,
  cliProxyLaunchArguments,
  cliProxyConfigured,
  cliProxyMessageKey,
  cliProxyModelLabel,
  cliProxyStatusCode,
  emptyCliProxySettings,
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


describe("proxy launch metadata", () => {
  it("keeps reverse proxy prefixes and refuses missing setup", () => {
    expect(cliProxyLaunchArguments(" https://proxy.example/prefix/ ")).toEqual([
      "-c", "model_provider=latticeterm_cliproxyapi", "-c",
      'model_providers.latticeterm_cliproxyapi.base_url="https://proxy.example/prefix/v1"',
    ]);
    expect(() => cliProxyLaunchArguments(" ")).toThrow("cliproxy.url.empty");
  });
});
