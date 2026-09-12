# Run only account-free native regression tests in an ephemeral CI copy.
[CmdletBinding()]
param(
    [switch]$SelfTest,
    [string]$ReportPath = "windows-native-tests-report.json"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

function Select-LibTestArtifact {
    param([string[]]$Lines, [string]$ManifestPath)
    $artifacts = @()
    $finished = @()
    foreach ($line in $Lines) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $event = ConvertFrom-Json -InputObject $line
        if ($event.reason -eq "build-finished") { $finished += $event }
        if ($event.reason -ne "compiler-artifact") { continue }
        if ($event.target.name -ne "latticeterm_lib" -or
            $event.profile.test -ne $true -or -not $event.executable) { continue }
        if (-not [string]::Equals($event.manifest_path, $ManifestPath,
                [StringComparison]::OrdinalIgnoreCase)) { continue }
        if (-not (@($event.target.crate_types) -contains "rlib")) { continue }
        $artifacts += [string]$event.executable
    }
    if ($finished.Count -ne 1 -or $finished[0].success -ne $true -or $artifacts.Count -ne 1) {
        throw "Cargo did not report exactly one successful library-test artifact."
    }
    return $artifacts[0]
}

function Get-TestNames {
    param([string[]]$Lines)
    $names = @($Lines | ForEach-Object {
        if ($_ -match '^([A-Za-z0-9_:]+): test$') { $Matches[1] }
    })
    if (@($names | Select-Object -Unique).Count -ne $names.Count) {
        throw "The native test inventory contains duplicate names."
    }
    return $names
}

function Get-TestResult {
    param([string[]]$Lines, [int]$ExpectedPassed, [int]$ExpectedIgnored)
    $summaries = @($Lines | Where-Object { $_ -match '^test result:' })
    if ($summaries.Count -ne 1 -or $ExpectedPassed -le 0 -or
        $summaries[0] -notmatch '^test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out; finished in ([\d.]+)s$') {
        throw "The native test run has no unambiguous successful summary."
    }
    $passed = [int]$Matches[1]
    $failed = [int]$Matches[2]
    $ignored = [int]$Matches[3]
    $measured = [int]$Matches[4]
    if ($passed -ne $ExpectedPassed -or $failed -ne 0 -or
        $ignored -ne $ExpectedIgnored -or $measured -ne 0) {
        throw "The native test result does not match its non-ignored inventory."
    }
    return [ordered]@{ passed = $passed; failed = $failed; ignored = $ignored }
}

function Assert-ContainedPath {
    param([string]$Path, [string]$Root)
    $resolved = [IO.Path]::GetFullPath($Path)
    $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
    if (-not $resolved.StartsWith($resolvedRoot + [IO.Path]::DirectorySeparatorChar,
            [StringComparison]::OrdinalIgnoreCase)) {
        throw "A native test path is outside its expected directory."
    }
    return $resolved
}

function Assert-CommonControlsManifest {
    param([string]$Path)
    $settings = [Xml.XmlReaderSettings]::new()
    $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
    $settings.XmlResolver = $null
    $reader = [Xml.XmlReader]::Create($Path, $settings)
    try {
        $document = [Xml.XmlDocument]::new()
        $document.XmlResolver = $null
        $document.Load($reader)
        $namespaces = [Xml.XmlNamespaceManager]::new($document.NameTable)
        $namespaces.AddNamespace("asm", "urn:schemas-microsoft-com:asm.v1")
        $identity = $document.SelectNodes(
            '/asm:assembly/asm:dependency/asm:dependentAssembly/asm:assemblyIdentity', $namespaces)
        if ($identity.Count -ne 1 -or $identity[0].name -ne "Microsoft.Windows.Common-Controls" -or
            $identity[0].version -ne "6.0.0.0" -or
            $identity[0].publicKeyToken -ne "6595b64144ccf1df") {
            throw "The test copy does not have the expected CommonControls v6 dependency."
        }
    } finally { $reader.Dispose() }
}

function Assert-NoReparseAncestors {
    param([string]$Path)
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if ((Test-Path -LiteralPath $current) -and
            ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "A native verification path has a reparse-point ancestor."
        }
        $parent = [IO.Directory]::GetParent($current)
        $current = if ($parent) { $parent.FullName } else { $null }
    }
}

function Get-TrustedManifestTool {
    $sdkRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits/10/bin"
    $sdkRoot = (Resolve-Path -LiteralPath $sdkRoot).Path
    $versions = @(Get-ChildItem -LiteralPath $sdkRoot -Directory |
        Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
        Sort-Object { [version]$_.Name } -Descending)
    foreach ($version in $versions) {
        $candidate = Join-Path $version.FullName "x64/mt.exe"
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        $candidate = Assert-ContainedPath (Resolve-Path -LiteralPath $candidate).Path $sdkRoot
        Assert-NoReparseAncestors $candidate
        $signature = Get-AuthenticodeSignature -LiteralPath $candidate
        if ($signature.Status -ne "Valid" -or -not $signature.SignerCertificate -or
            $signature.SignerCertificate.Subject -notmatch '(?:^|,\s*)O=Microsoft Corporation(?:,|$)') {
            throw "The Windows SDK manifest tool does not have a valid Microsoft signature."
        }
        return [ordered]@{
            path = $candidate
            sdkVersion = $version.Name
            sha256 = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash
        }
    }
    throw "No trusted x64 Windows SDK manifest tool was found."
}

function Invoke-NativeChecked {
    param([string]$Executable, [string[]]$Arguments)
    $output = @(& $Executable @Arguments)
    $code = $LASTEXITCODE
    $output | ForEach-Object { Write-Host $_ }
    if ($code -ne 0) { throw "A native verification command returned a nonzero exit code: $code." }
    return $output
}

if ($SelfTest) {
    $manifest = Join-Path $PSScriptRoot "../src-tauri/Cargo.toml"
    $artifact = @{
        reason = "compiler-artifact"; manifest_path = $manifest; executable = "owned-test.exe"
        target = @{ name = "latticeterm_lib"; crate_types = @("rlib") }
        profile = @{ test = $true }
    } | ConvertTo-Json -Depth 5 -Compress
    $success = '{"reason":"build-finished","success":true}'
    if ((Select-LibTestArtifact @($artifact, $success) $manifest) -ne "owned-test.exe") {
        throw "Artifact selection self-test failed."
    }
    foreach ($lines in @(
        @($artifact, $artifact, $success), @($artifact),
        @($artifact, '{"reason":"build-finished","success":false}'),
        @($artifact.Replace("latticeterm_lib", "other_lib"), $success),
        @($artifact.Replace('"test":true', '"test":false'), $success)
    )) {
        $rejected = $false
        try { $null = Select-LibTestArtifact $lines $manifest } catch { $rejected = $true }
        if (-not $rejected) { throw "Unsafe Cargo artifact self-test failed." }
    }
    $names = @(Get-TestNames @("agent::one: test", "agent::two: test", "2 tests, 0 benchmarks"))
    if ($names.Count -ne 2) { throw "Native test inventory self-test failed." }
    $valid = "test result: ok. 2 passed; 0 failed; 1 ignored; 0 measured; 9 filtered out; finished in 0.01s"
    $null = Get-TestResult @($valid) 2 1
    foreach ($lines in @(@(), @($valid, $valid), @($valid.Replace("2 passed", "0 passed")),
            @($valid.Replace("0 failed", "1 failed")), @($valid.Replace("1 ignored", "0 ignored")))) {
        $rejected = $false
        try { $null = Get-TestResult $lines 2 1 } catch { $rejected = $true }
        if (-not $rejected) { throw "Native test result self-test failed." }
    }
    $inside = Join-Path $PSScriptRoot "owned-report.json"
    if ((Assert-ContainedPath $inside $PSScriptRoot) -ne $inside) {
        throw "Owned path containment self-test failed."
    }
    foreach ($outside in @($PSScriptRoot, (Join-Path $PSScriptRoot "../outside.json"))) {
        $rejected = $false
        try { $null = Assert-ContainedPath $outside $PSScriptRoot } catch { $rejected = $true }
        if (-not $rejected) { throw "Unsafe cleanup path self-test failed." }
    }
    Assert-CommonControlsManifest (Join-Path $PSScriptRoot "windows-lib-test.manifest")
    Write-Host "Windows native regression runner self-tests passed (no native test process or Cargo started)."
    exit 0
}

if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne "true" -or -not $env:RUNNER_TEMP) {
    throw "This native runner is restricted to ephemeral Windows GitHub Actions jobs."
}

$repository = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$reportFile = Assert-ContainedPath ([IO.Path]::GetFullPath($ReportPath, $repository)) $repository
Assert-NoReparseAncestors $reportFile
if (Test-Path -LiteralPath $reportFile) { throw "The native report path already exists." }
$temporaryRoot = (Resolve-Path -LiteralPath $env:RUNNER_TEMP).Path
$ownedDirectory = $null
$artifactPath = $null
$originalHash = $null
$failure = $null
$report = [ordered]@{
    schemaVersion = 1
    passed = $false
    scope = "Windows account-free library regressions; ignored provider acceptance is not executed"
    cargo = [ordered]@{ passed = $false; profile = "release"; target = "latticeterm_lib" }
    manifest = [ordered]@{ passed = $false; originalArtifactUnchanged = $null }
    tests = @()
    cleanup = [ordered]@{
        passed = $false
        scope = "Owned runner directory; child cleanup is verified by the individual native tests"
    }
}
try {
    $ownedDirectory = Join-Path $temporaryRoot ("latticeterm-native-tests-" + [guid]::NewGuid().ToString("N"))
    $ownedDirectory = Assert-ContainedPath $ownedDirectory $temporaryRoot
    $null = New-Item -ItemType Directory -Path $ownedDirectory
    $manifestPath = (Resolve-Path -LiteralPath (Join-Path $repository "src-tauri/Cargo.toml")).Path
    $targetDirectory = Join-Path $repository "src-tauri/target"
    $cargoLog = Join-Path $ownedDirectory "cargo-artifacts.jsonl"
    Push-Location (Join-Path $repository "src-tauri")
    try {
        & cargo test --lib --release --no-run --locked --message-format=json-render-diagnostics --target-dir $targetDirectory 1> $cargoLog
        if ($LASTEXITCODE -ne 0) { throw "Cargo library-test compilation failed." }
    } finally { Pop-Location }
    $artifactPath = Select-LibTestArtifact (Get-Content -LiteralPath $cargoLog) $manifestPath
    $artifactPath = Assert-ContainedPath $artifactPath (Join-Path $targetDirectory "release/deps")
    $artifactPath = (Resolve-Path -LiteralPath $artifactPath).Path
    if ([IO.Path]::GetExtension($artifactPath) -ne ".exe" -or
        ((Get-Item -LiteralPath $artifactPath).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Cargo reported an unexpected native library-test file."
    }
    $originalHash = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash
    $report.cargo.passed = $true
    $report.cargo.artifactSha256 = $originalHash
    $testCopy = Join-Path $ownedDirectory ([IO.Path]::GetFileName($artifactPath))
    Copy-Item -LiteralPath $artifactPath -Destination $testCopy
    $manifest = Join-Path $PSScriptRoot "windows-lib-test.manifest"
    Assert-CommonControlsManifest $manifest
    $tool = Get-TrustedManifestTool
    $null = Invoke-NativeChecked $tool.path @("-nologo", "-manifest", $manifest, "-outputresource:$testCopy;#1")
    $embeddedManifest = Join-Path $ownedDirectory "embedded.manifest"
    $null = Invoke-NativeChecked $tool.path @("-nologo", "-inputresource:$testCopy;#1", "-out:$embeddedManifest")
    Assert-CommonControlsManifest $embeddedManifest
    $report.manifest.passed = $true
    $report.manifest.sdkVersion = $tool.sdkVersion
    $report.manifest.toolSha256 = $tool.sha256
    $report.manifest.toolSignature = "Valid Microsoft Corporation"
    $report.manifest.testCopySha256 = (Get-FileHash -LiteralPath $testCopy -Algorithm SHA256).Hash
    foreach ($filter in @("codex_input_profile", "codex_mcp_submit", "startup_seed",
            "windows_pty_environment", "conpty_startup", "desktop_ownership", "agent_daemon::", "mcp_desktop::", "metrics::",
            "remote_host::", "remote_commands::", "remote_chat_host::")) {
        $check = [ordered]@{ filter = $filter; passed = $false }
        $report.tests += $check
        $all = @(Get-TestNames (Invoke-NativeChecked $testCopy @($filter, "--list", "--format", "terse")))
        $ignored = @(Get-TestNames (Invoke-NativeChecked $testCopy @($filter, "--list", "--ignored", "--format", "terse")))
        if (@($ignored | Where-Object { $_ -notin $all }).Count -ne 0) {
            throw "The ignored native test inventory is inconsistent."
        }
        $expected = $all.Count - $ignored.Count
        if ($expected -le 0) { throw "A required native filter has no non-ignored tests." }
        # No --ignored / --include-ignored: native provider acceptance stays opt-in.
        $result = Get-TestResult (Invoke-NativeChecked $testCopy @($filter, "--test-threads=1", "--color", "never")) $expected $ignored.Count
        $check.passed = $true
        $check.counts = $result
    }
    # This account-free opt-in runs the real MCP executable behind both
    # Windows OpenSSH default shell shapes, then verifies two ConPTY sessions.
    $fleetFilter = "mcp_desktop::loopback_tests::fleet::windows_fleet_native_bootstrap_supports_both_ssh_shells"
    $fleetCheck = [ordered]@{ filter = $fleetFilter; passed = $false }
    $report.tests += $fleetCheck
    $fleetNames = @(Get-TestNames (Invoke-NativeChecked $testCopy @($fleetFilter, "--exact", "--list", "--ignored", "--format", "terse")))
    if ($fleetNames.Count -ne 1) { throw "The Windows Fleet bootstrap test is missing." }
    $oldFleetBinary = $env:LATTICETERM_FLEET_TEST_BINARY
    try {
        $env:LATTICETERM_FLEET_TEST_BINARY = Join-Path $targetDirectory "release/lattice-term.exe"
        $fleetCheck.counts = Get-TestResult (Invoke-NativeChecked $testCopy @($fleetFilter, "--exact", "--ignored", "--test-threads=1", "--color", "never")) 1 0
        $fleetCheck.passed = $true
    } finally { $env:LATTICETERM_FLEET_TEST_BINARY = $oldFleetBinary }
    $report.passed = $true
} catch {
    $failure = $_
    $report.failureCode = "native-regression-step-failed"
} finally {
    try {
        if ($artifactPath -and $originalHash) {
            $unchanged = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash -eq $originalHash
            $report.manifest.originalArtifactUnchanged = $unchanged
            if (-not $unchanged) { throw "The original Cargo artifact changed." }
        }
    } catch {
        $failure = $_
        $report.failureCode = "native-regression-artifact-integrity-failed"
    }
    try {
        if ($ownedDirectory -and (Test-Path -LiteralPath $ownedDirectory)) {
            $resolvedOwned = Assert-ContainedPath (Resolve-Path -LiteralPath $ownedDirectory).Path $temporaryRoot
            if ($resolvedOwned -ne $ownedDirectory -or
                ((Get-Item -LiteralPath $resolvedOwned).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw "The owned native test directory changed before cleanup."
            }
            Remove-Item -LiteralPath $resolvedOwned -Recurse -Force
            if (Test-Path -LiteralPath $resolvedOwned) { throw "The native test fixture was not removed." }
        }
        $report.cleanup.passed = $true
    } catch {
        $failure = $_
        $report.failureCode = "native-regression-cleanup-or-artifact-integrity-failed"
    }
    if ($failure) { $report.passed = $false }
    # Do not replace an independently created report, even if it appeared
    # after the initial existence check. Keep output inside the repository.
    Assert-NoReparseAncestors $reportFile
    $reportStream = [IO.File]::Open($reportFile, [IO.FileMode]::CreateNew,
        [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $reportBytes = [Text.UTF8Encoding]::new($false).GetBytes(($report | ConvertTo-Json -Depth 8))
        $reportStream.Write($reportBytes, 0, $reportBytes.Length)
        $reportStream.Flush()
    } finally { $reportStream.Dispose() }
}
if ($failure) { throw $failure }
Write-Host "Windows native regressions passed; the original Cargo artifact was not modified."
