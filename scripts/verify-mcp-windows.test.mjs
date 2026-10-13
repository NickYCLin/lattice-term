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
