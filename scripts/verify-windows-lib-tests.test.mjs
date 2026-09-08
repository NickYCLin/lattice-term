import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const script = readFileSync(new URL("./verify-windows-lib-tests.ps1", import.meta.url), "utf8");
const manifest = readFileSync(new URL("./windows-lib-test.manifest", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../.github/workflows/windows-test-installer.yml", import.meta.url), "utf8");

describe("Windows account-free native regression CI", () => {
  test("runs only in ephemeral CI and discovers the exact Cargo lib-test artifact", () => {
    expect(script).toContain('$env:GITHUB_ACTIONS -ne "true"');
    expect(script).toContain("--lib --release --no-run --locked --message-format=json-render-diagnostics");
    expect(script).toContain('$event.target.name -ne "latticeterm_lib"');
    expect(script).toContain('$event.profile.test -ne $true');
    expect(script).toContain("$event.manifest_path, $ManifestPath");
    expect(script).toContain("$artifacts.Count -ne 1");
    expect(script).not.toMatch(/Get-ChildItem[^\n]*\*\.exe/);
  });

  test("requires a signed SDK tool and changes only the owned test copy", () => {
    expect(script).toContain('"Windows Kits/10/bin"');
    expect(script).toContain('"x64/mt.exe"');
    expect(script).toContain('$signature.Status -ne "Valid"');
    expect(script).toContain("Microsoft Corporation");
    expect(script).toContain("Assert-NoReparseAncestors $candidate");
    expect(script).toContain('"-outputresource:$testCopy;#1"');
    expect(script).toContain('"-inputresource:$testCopy;#1"');
    expect(script).not.toContain('"-outputresource:$artifactPath');
    expect(script).toContain("originalArtifactUnchanged");
    expect(script).toContain("Assert-ContainedPath (Resolve-Path -LiteralPath $ownedDirectory).Path $temporaryRoot");
    expect(script).toContain("Remove-Item -LiteralPath $resolvedOwned -Recurse -Force");
    expect(manifest).toContain('name="Microsoft.Windows.Common-Controls"');
    expect(manifest).toContain('version="6.0.0.0"');
  });

  test("requires nonzero matching inventories and does not run ignored provider tests", () => {
    for (const filter of ["codex_input_profile", "codex_mcp_submit", "startup_seed", "windows_pty_environment", "desktop_ownership", "agent_daemon::", "mcp_desktop::", "metrics::"]) {
      expect(script).toContain(`"${filter}"`);
    }
    expect(script).toContain('"--list", "--ignored"');
    expect(script).toContain('Invoke-NativeChecked $testCopy @($filter, "--test-threads=1", "--color", "never")');
    expect(script).toContain("$passed -ne $ExpectedPassed");
    expect(script).toContain("$ignored -ne $ExpectedIgnored");
    expect(script).toContain("if ($expected -le 0)");
    expect(script).toContain("if ($code -ne 0)");
    expect(script).toContain("if ($failure) { throw $failure }");
    expect(script).toContain("[IO.FileMode]::CreateNew");
    expect(script).toContain("[IO.FileShare]::None");
    expect(script).toContain("Assert-ContainedPath ([IO.Path]::GetFullPath($ReportPath, $repository)) $repository");
  });

  test("wires contracts, native execution and an always-uploaded report into the existing job", () => {
    expect(workflow).toContain("./scripts/verify-windows-lib-tests.ps1 -SelfTest");
    expect(workflow).toContain("run: ./scripts/verify-windows-lib-tests.ps1\n");
    expect(workflow).toMatch(/name: Upload Windows native regression report\r?\n\s+if: always\(\)/);
    expect(workflow).toContain("path: windows-native-tests-report.json");
    for (const path of ["scripts/verify-windows-lib-tests.ps1", "scripts/verify-windows-lib-tests.test.mjs", "scripts/windows-lib-test.manifest"]) {
      expect(workflow).toContain(`- "${path}"`);
    }
    expect(workflow).not.toContain("continue-on-error:");
  });
});
