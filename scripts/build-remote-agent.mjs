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
  throw new Error(`Unsupported Lattice Remote target: ${process.platform}-${process.arch}`);
}

const environment = sidecarBuildEnvironment();
if (process.platform === "linux" && !environment.BINDGEN_EXTRA_CLANG_ARGS) {
  const gccInclude = execFileSync("gcc", ["-print-file-name=include"], {
    encoding: "utf8",
  }).trim();
  environment.BINDGEN_EXTRA_CLANG_ARGS = `-I${gccInclude}`;
}

const args = [
  "build",
  "--manifest-path",
  join(root, "crates/lattice-remote/Cargo.toml"),
  "--features",
  "agent,client-cli",
  "--bin",
  "lattice-agent",
  "--bin",
  "lattice-remote",
];
if (release) args.push("--release");
execFileSync("cargo", args, {
  cwd: root,
  env: environment,
  stdio: "inherit",
});

const extension = process.platform === "win32" ? ".exe" : "";
const profile = release ? "release" : "debug";
const binaryDir = join(root, "src-tauri/binaries");
mkdirSync(binaryDir, { recursive: true });
for (const binary of ["lattice-agent", "lattice-remote"]) {
  const source = join(
    root,
    "crates/lattice-remote/target",
    profile,
    `${binary}${extension}`,
  );
  const destination = join(binaryDir, `${binary}-${triple}${extension}`);
  copyFileSync(source, destination);
  console.log(`Prepared ${destination}`);
}
