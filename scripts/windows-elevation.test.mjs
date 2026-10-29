import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const main = readFileSync(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");
const build = readFileSync(new URL("../src-tauri/build.rs", import.meta.url), "utf8");
const shell = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

describe("Windows desktop elevation boundary", () => {
  test("dispatches every helper before requesting desktop elevation", () => {
    const elevation = main.indexOf("windows_elevation::ensure_elevated(&arguments)");
    expect(elevation).toBeGreaterThan(0);
    for (const helper of [
      "cliproxy::desktop::run_cli",
      "agent::run_reporter_cli",
      "agent_daemon::server::run_cli",
      "agent_daemon::mcp::run_cli",
    ]) {
      expect(main.indexOf(helper)).toBeGreaterThan(0);
      expect(main.indexOf(helper)).toBeLessThan(elevation);
    }
    expect(elevation).toBeLessThan(main.indexOf("latticeterm_lib::run()"));
  });

  test("limits runtime elevation to Windows without elevating the shared binary manifest", () => {
    const statements = main.split(String.fromCharCode(10)).map((line) => line.trim()).join(" ");
    expect(statements).toContain("#[cfg(windows)] use latticeterm_lib::windows_elevation;");
    expect(statements).toContain("#[cfg(windows)] match windows_elevation::ensure_elevated");
    expect(build).not.toContain("requireAdministrator");
    expect(build).toContain("Microsoft.Windows.Common-Controls");
  });

  test("shares cleaned restart arguments with the updater before plugin setup", () => {
    const environment = shell.indexOf("builder.manage(windows_elevation::restart_environment())");
    expect(environment).toBeGreaterThan(0);
    expect(environment).toBeLessThan(shell.indexOf("builder.plugin(tauri_plugin_updater::Builder"));
    expect(shell).toMatch(/#\[cfg\(windows\)\]\s+let builder = builder\.manage\(windows_elevation::restart_environment\(\)\)/);
  });
});
