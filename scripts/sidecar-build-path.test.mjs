import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sidecarBinaryPath } from "./sidecar-build-path.mjs";

describe("Cargo sidecar 產物路徑", () => {
  let cwd;
  let manifestPath;
  let environment;

  beforeEach(() => {
    mkdirSync("output", { recursive: true });
    cwd = mkdtempSync(resolve("output/sidecar-path-"));
    manifestPath = join(cwd, "crate/Cargo.toml");
    mkdirSync(dirname(manifestPath));
    writeFileSync(manifestPath, '[package]\nname = "sidecar-path-fixture"\nversion = "0.1.0"\n[lib]\npath = "lib.rs"\n');
    writeFileSync(join(dirname(manifestPath), "lib.rs"), "");
    environment = { ...process.env };
    delete environment.CARGO_TARGET_DIR;
    delete environment.CARGO_BUILD_TARGET_DIR;
  });

  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  function checkPath(targetDirectory, profile = "debug", binary = "lattice-rdp-engine") {
    const expected = join(targetDirectory, profile, binary);
    mkdirSync(dirname(expected), { recursive: true });
    writeFileSync(expected, "fixture");
    expect(sidecarBinaryPath({ cwd, manifestPath, environment, profile, binary })).toBe(expected);
  }

  it("未設定時沿用 crate 的 target 目錄", () => {
    checkPath(join(cwd, "crate/target"));
  });

  for (const variable of ["CARGO_TARGET_DIR", "CARGO_BUILD_TARGET_DIR"]) {
    it(`${variable} 接受絕對路徑`, () => {
      environment[variable] = join(cwd, "absolute target");
      checkPath(environment[variable]);
    });

    it(`${variable} 相對於 cargo cwd，而非 manifest 目錄`, () => {
      environment[variable] = "relative target";
      checkPath(join(cwd, "relative target"));
    });
  }

  it("CARGO_TARGET_DIR 優先於 CARGO_BUILD_TARGET_DIR", () => {
    environment.CARGO_TARGET_DIR = "preferred";
    environment.CARGO_BUILD_TARGET_DIR = "other";
    checkPath(join(cwd, "preferred"));
  });

  it("尊重 Cargo config 的 target-dir", () => {
    mkdirSync(join(cwd, ".cargo"));
    writeFileSync(join(cwd, ".cargo/config.toml"), '[build]\ntarget-dir = "configured target"\n');
    checkPath(join(cwd, "configured target"));
  });

  it("支援 release 與 Windows 執行檔副檔名", () => {
    environment.CARGO_TARGET_DIR = "release target";
    checkPath(join(cwd, "release target"), "release", "lattice-agent.exe");
  });

  it("產物不存在時列出實際嘗試的路徑，不改用舊產物", () => {
    environment.CARGO_TARGET_DIR = "missing";
    const stale = join(cwd, "crate/target/debug/lattice-rdp-engine");
    mkdirSync(dirname(stale), { recursive: true });
    writeFileSync(stale, "stale");
    expect(() => sidecarBinaryPath({
      cwd, manifestPath, environment, profile: "debug", binary: "lattice-rdp-engine",
    })).toThrow(`嘗試的路徑：\n- ${join(cwd, "missing/debug/lattice-rdp-engine")}`);
  });
});
