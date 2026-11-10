import { describe, expect, it } from "vitest";
import { cliProxyCatalogByVendor, cliProxyModelCapability, cliProxyModelVendor } from "./cliProxyModelCatalog";

const model = (id: string, ownedBy: string | null = null) => ({ id, ownedBy });

describe("CLIProxyAPI model catalog", () => {
  it("reads the maker from the id, not the login channel", () => {
    expect(cliProxyModelVendor(model("claude-sonnet-5-5-high", "antigravity"))).toBe("Anthropic");
    expect(cliProxyModelVendor(model("gemini-4-argon-high", "antigravity"))).toBe("Google");
    expect(cliProxyModelVendor(model("gpt-oss-120b-medium", "antigravity"))).toBe("OpenAI");
    expect(cliProxyModelVendor(model("grok-4.3", "xai"))).toBe("xAI");
    expect(cliProxyModelVendor(model("models/gemini-2.5-pro"))).toBe("Google");
    expect(cliProxyModelVendor(model("text-embedding-004"))).toBe("Google");
    expect(cliProxyModelVendor(model("text-embedding-3-large"))).toBe("OpenAI");
    expect(cliProxyModelVendor(model("o4-mini"))).toBe("OpenAI");
    expect(cliProxyModelVendor(model("unknown-model", "acme"))).toBe("acme");
    expect(cliProxyModelVendor(model("unknown-model"))).toBeNull();
  });

  it.each([
    ["claude-opus-5-5-high", "text"],
    ["gpt-5.6-terra", "text"],
    ["gemini-2.5-flash-image", "image"],
    ["imagen-4.0-generate", "image"],
    ["gpt-image-1", "image"],
    ["dall-e-3", "image"],
    ["veo-3.1", "video"],
    ["sora-2", "video"],
    ["grok-voice-tts-1.0", "audio"],
    ["gpt-4o-realtime", "audio"],
    ["whisper-1", "audio"],
    ["text-embedding-3-large", "embedding"],
    ["gemini-embedding-001", "embedding"],
  ])("guesses %s is for %s", (id, capability) => {
    expect(cliProxyModelCapability(model(id))).toBe(capability);
  });

  it("groups by maker, keeps the proxy channel and puts unknown makers last", () => {
    const groups = cliProxyCatalogByVendor([
      model("mystery"),
      model("claude-sonnet-5-5-high", "antigravity"),
      model("gemini-2.5-flash-image", "antigravity"),
      model("claude-opus-5-5-high", "anthropic"),
    ]);
    expect(groups.map(group => group.vendor)).toEqual(["Anthropic", "Google", null]);
    expect(groups[0].models.map(entry => entry.model.ownedBy)).toEqual(["antigravity", "anthropic"]);
    expect(groups[1].models[0].capability).toBe("image");
  });
});
