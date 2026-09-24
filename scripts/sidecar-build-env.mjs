// Sidecars are built outside tauri-build, so they do not get its static
// VC runtime linking. Link the MSVC CRT statically on Windows so the
// bundled executables start on machines without the VC++ Redistributable,
// such as Windows Sandbox.
export function sidecarBuildEnvironment(base = process.env) {
  const environment = { ...base };
  if (process.platform !== "win32") return environment;
  const flag = "-C target-feature=+crt-static";
  if (environment.CARGO_ENCODED_RUSTFLAGS !== undefined) {
    const current = environment.CARGO_ENCODED_RUSTFLAGS;
    if (!current.includes("+crt-static")) {
      environment.CARGO_ENCODED_RUSTFLAGS = [current, "-C", "target-feature=+crt-static"]
        .filter(Boolean)
        .join("\x1f");
    }
    return environment;
  }
  const current = environment.RUSTFLAGS ?? "";
  if (!current.includes("+crt-static")) {
    environment.RUSTFLAGS = current ? `${current} ${flag}` : flag;
  }
  return environment;
}
