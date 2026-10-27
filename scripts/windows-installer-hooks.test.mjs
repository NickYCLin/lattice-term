import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { expect, test } from "vitest";

const hook = resolve("src-tauri/windows/installer-hooks.nsh");
const makensis = join(process.env.LOCALAPPDATA ?? "", "tauri/NSIS/makensis.exe");

test("the Windows bundle enables the installer hook", () => {
  const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  expect(resolve("src-tauri", config.bundle.windows.nsis.installerHooks)).toBe(hook);
});

// Execute real Restart Manager calls against a disposable ping executable.
// This installer only writes a result file inside its temporary directory:
// it neither installs nor shuts down any application.
test.skipIf(process.platform !== "win32" || !existsSync(makensis))(
  "waits for an exiting executable, bounds a persistent lock, and leaves manual installs alone",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "lattice-nsis-exit-"));
    const binary = join(directory, "probe.exe");
    copyFileSync(join(process.env.SystemRoot, "System32/ping.exe"), binary);
    const installer = join(directory, "probe-installer.exe");
    const source = join(directory, "probe.nsi");
    writeFileSync(source, `
Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "${installer}"
!include FileFunc.nsh
Var UpdateMode
!define LATTICETERM_UPDATE_WAIT_ATTEMPTS 15
!define LATTICETERM_UPDATE_WAIT_INTERVAL_MS 100
!include "${hook}"
; Match Tauri: it includes hooks before defining MAINBINARYNAME.
!define MAINBINARYNAME "probe"
Section
  StrCpy $INSTDIR "${directory}"
  StrCpy $UpdateMode 0
  \${GetOptions} $CMDLINE "/UPDATE" $R9
  \${IfNot} \${Errors}
    StrCpy $UpdateMode 1
  \${EndIf}
  StrCpy $R0 "session-sentinel"
  StrCpy $0 "result-sentinel"
  StrCpy $1 "needed-sentinel"
  StrCpy $2 "count-sentinel"
  StrCpy $3 "reason-sentinel"
  StrCpy $4 "attempt-sentinel"
  !insertmacro NSIS_HOOK_PREINSTALL
  FileOpen $R9 "${directory}\\result.txt" w
  FileWrite $R9 "$R0|$0|$1|$2|$3|$4"
  FileClose $R9
SectionEnd
`);
    const compile = spawnSync(makensis, ["/V2", source], { encoding: "utf8", timeout: 15000 });
    expect(compile.status, compile.stdout + compile.stderr).toBe(0);

    async function run(update) {
      const started = performance.now();
      const child = spawn(installer, update ? ["/S", "/UPDATE"] : ["/S"], { windowsHide: true });
      expect((await once(child, "exit"))[0]).toBe(0);
      expect(readFileSync(join(directory, "result.txt"), "utf8")).toBe(
        "session-sentinel|result-sentinel|needed-sentinel|count-sentinel|reason-sentinel|attempt-sentinel",
      );
      return performance.now() - started;
    }

    expect(await run(true)).toBeLessThan(1200);
    let blocker;
    try {
      blocker = spawn(binary, ["-n", "2", "127.0.0.1"], { windowsHide: true, stdio: "ignore" });
      const transient = await run(true);
      expect(transient).toBeGreaterThan(400);
      expect(transient).toBeLessThan(6000);
      if (blocker.exitCode === null) await once(blocker, "exit");
      blocker = spawn(binary, ["-t", "127.0.0.1"], { windowsHide: true, stdio: "ignore" });
      expect(await run(false)).toBeLessThan(1200);
      const bounded = await run(true);
      expect(bounded).toBeGreaterThan(1300);
      expect(bounded).toBeLessThan(6000);
      expect(blocker.exitCode).toBeNull();
    } finally {
      // Only terminate the disposable process this test created.
      if (blocker?.exitCode === null) blocker.kill();
    }
  },
  30000,
);
