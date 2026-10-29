import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Ask Cargo using the build's cwd and environment so relative target-dir values,
// environment precedence, workspace roots, and Cargo config stay Cargo's concern.
export function sidecarBinaryPath({ cwd, manifestPath, environment, profile, binary }) {
  const metadata = JSON.parse(execFileSync("cargo", [
    "metadata", "--format-version", "1", "--no-deps",
    "--manifest-path", manifestPath,
  ], { cwd, env: environment, encoding: "utf8" }));
  const source = resolve(cwd, metadata.target_directory, profile, binary);
  if (!existsSync(source)) {
    throw new Error(
      `找不到 Cargo sidecar 產物 ${binary}（${profile}）。` +
      `\nManifest: ${manifestPath}\n嘗試的路徑：\n- ${source}`,
    );
  }
  return source;
}
