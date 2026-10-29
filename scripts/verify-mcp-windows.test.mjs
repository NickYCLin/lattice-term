import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("Windows acceptance expects the daemon's complete MCP inventory", () => {
  const daemon = readFileSync(new URL("../src-tauri/src/agent_daemon/mcp.rs", import.meta.url), "utf8");
  const acceptance = readFileSync(new URL("./verify-mcp-windows.mjs", import.meta.url), "utf8");
  const daemonList = daemon.match(/const TOOL_NAMES: \[&str; \d+\] = \[([\s\S]*?)\];/);
  const acceptanceList = acceptance.match(/assert\.deepEqual\(tools\.tools\.map\(\(tool\) => tool\.name\)\.sort\(\), \[([\s\S]*?)\]\.sort\(\)\);/);
  expect(daemonList).not.toBeNull();
  expect(acceptanceList).not.toBeNull();
  const names = source => [...source.matchAll(/"([a-z_]+)"/g)].map(match => match[1]).sort();
  expect(names(acceptanceList[1])).toEqual(names(daemonList[1]));
});

// Run on Linux too: a stale observer version must fail before Windows CI.
test("Windows greeting and legacy isolation use the daemon's role protocols", () => {
  const daemon = readFileSync(new URL("../src-tauri/src/agent_daemon/mod.rs", import.meta.url), "utf8");
  const acceptance = readFileSync(new URL("./verify-mcp-windows.mjs", import.meta.url), "utf8");
  const version = (source, name, rust = false) => {
    const match = source.match(new RegExp(`(?:pub const|const) ${name}${rust ? ": u32" : ""} = (\\d+);`));
    expect(match, name).not.toBeNull();
    return Number(match[1]);
  };
  const desktop = version(daemon, "PROTOCOL_VERSION", true);
  const observer = version(daemon, "OBSERVER_PROTOCOL_VERSION", true);
  expect(version(acceptance, "DESKTOP_PROTOCOL_VERSION")).toBe(desktop);
  expect(version(acceptance, "OBSERVER_PROTOCOL_VERSION")).toBe(observer);
  expect(observer).not.toBe(desktop);
  expect(acceptance).toContain('protocol: role === "observer" ? OBSERVER_PROTOCOL_VERSION : DESKTOP_PROTOCOL_VERSION');
  // Keep the isolation check strict: every greeting, the exact version and role.
  expect(acceptance).toMatch(/greetings\.every\(\(entry\) => entry\.type === "hello" &&\s*entry\.protocol === OBSERVER_PROTOCOL_VERSION && entry\.role === "observer"/);
  expect(acceptance).toContain("observerProtocol: OBSERVER_PROTOCOL_VERSION");
});
