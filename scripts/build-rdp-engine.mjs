import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sidecarBuildEnvironment } from "./sidecar-build-env.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const release = process.argv.includes("--release");
const triples = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
};
const triple = triples[`${process.platform}-${process.arch}`];
if (!triple) {
  throw new Error(`Unsupported RDP engine target: ${process.platform}-${process.arch}`);
}

const args = [
  "build",
  "--manifest-path",
  join(root, "crates/lattice-rdp/Cargo.toml"),
];
if (release) args.push("--release");
execFileSync("cargo", args, {
  cwd: root,
  env: sidecarBuildEnvironment(),
  stdio: "inherit",
});

const extension = process.platform === "win32" ? ".exe" : "";
const profile = release ? "release" : "debug";
const source = join(
  root,
  "crates/lattice-rdp/target",
  profile,
  `lattice-rdp-engine${extension}`,
);
const binaryDir = join(root, "src-tauri/binaries");
const destination = join(
  binaryDir,
  `lattice-rdp-engine-${triple}${extension}`,
);
mkdirSync(binaryDir, { recursive: true });
copyFileSync(source, destination);
console.log(`Prepared ${destination}`);
