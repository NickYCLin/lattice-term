import { describe, expect, it } from "vitest";
import { webSources } from "./chatWebSources";

describe("web sources", () => {
  it("reads Claude's link list with titles", () => {
    const output = [
      'Web search results for query: "tauri opener"',
      "",
      'Links: [{"title":"Opener | Tauri","url":"https://v2.tauri.app/plugin/opener/"},{"title":"crates.io: \\"opener\\"","url":"https://crates.io/crates/tauri-plugin-opener"}]',
      "",
      "See https://v2.tauri.app/plugin/opener/ for details.",
    ].join("\n");
    expect(webSources("WebSearch", output)).toEqual([
      { url: "https://v2.tauri.app/plugin/opener/", title: "Opener | Tauri" },
      { url: "https://crates.io/crates/tauri-plugin-opener", title: 'crates.io: "opener"' },
    ]);
  });

  it("falls back to plain addresses, trimming sentence punctuation", () => {
    expect(
      webSources("google_web_search", "Sources:\n[1] Example (https://example.com/a).\nMore at https://example.org."),
    ).toEqual([
      { url: "https://example.com/a", title: "example.com" },
      { url: "https://example.org/", title: "example.org" },
    ]);
  });

  it("ignores other tools and anything that is not a web address", () => {
    expect(webSources("Bash", "curl https://example.com")).toEqual([]);
    expect(
      webSources("WebSearch", 'Links: [{"title":"x","url":"javascript:alert(1)"},{"title":"f","url":"file:///etc/passwd"}]'),
    ).toEqual([]);
  });

  it("survives a link list cut off by the output limit", () => {
    const output = 'Links: [{"title":"A","url":"https://a.example/"},{"title":"B","url":"https://b.exa\n…';
    expect(webSources("WebSearch", output).map((source) => source.url)).toEqual([
      "https://a.example/",
    ]);
  });
});
