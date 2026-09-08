import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { cancellationWorkers, cancelPrerequisiteFailure, classifyProviderOutput, codexProgressSignals, compilerResultMatches, disabledMcpArguments, fixtureSnapshot, fixtureTrustArguments, liveChecksPassed, liveWorkers, makeFixtures, MCP_REVIEW_OUTPUT_OPTIONS, McpReviewVerifier, nativeExitClassification, nativeInputProbeScript, ownedCliCleanupEvidence, ownedFixtureTrustReady, pairCheckerScript, pairCodexArguments, pairCompilerArguments, pairPrompt, parseOptions, recordLifecycle, requiredLiveChecks, reviewPrompt, startupSignals, taskFailureSignals, TerminalQueryResponder, verifiedResult } from "./verify-mcp-live-agents.mjs";
import { composerHints, recordTaskSignals, reportedCheckerFailures, settleDiagnosticParsers, taskSignalSnapshot } from "./verify-mcp-live-agents.mjs";

test("an integer followed by sentence punctuation keeps the exact answer boundary", () => {
  const nonce = "88888888-2222-4333-8444-555555555555";
  for (const ending of ["; checker failed with exit code 1.", ".", ", additional context", ": explanation"]) {
    assert.equal(verifiedResult(`LATTICE_RESULT ${nonce} 22${ending}`, nonce, 22), true);
  }
  for (const suffix of [".5", ",000", ":11", ";9", "wrong", "0"]) {
    assert.equal(verifiedResult(`LATTICE_RESULT ${nonce} 22${suffix}`, nonce, 22), false);
  }
  assert.equal(verifiedResult(`LATTICE_RESULT ${nonce} 21; explanation`, nonce, 22), false);
  assert.equal(verifiedResult("LATTICE_RESULT 77777777-2222-4333-8444-555555555555 22; explanation", nonce, 22), false);
});

test("correct source review does not erase a reported compiler failure", async () => {
  const nonce = "88888888-2222-4333-8444-555555555555";
  const verifier = new McpReviewVerifier(nonce, 22);
  try {
    const evidence = await verifier.feed(`LATTICE_RESULT ${nonce} 22; checker failed with exit code 1.`);
    assert.equal(evidence.correctNonceAndComputedValue, true);
    assert.deepEqual(evidence.reportedCheckerFailures, [1]);
    assert.equal(evidence.checkerFailureSource, "untrusted-cli-text-not-independent-compiler-execution-proof");
    // Simulate the bounded raw tail aging out, then clear the rendered view.
    verifier.text = "";
    const later = await verifier.feed("\x1b[2J\x1b[HNo current result");
    assert.equal(later.correctNonceAndComputedValue, false);
    assert.equal(later.reportedCheckerFailure, true);
    assert.deepEqual(later.reportedCheckerFailures, [1]);
  } finally { verifier.dispose(); }
});

test("reported compiler failure metadata is bounded and excludes arbitrary error text", () => {
  assert.deepEqual(reportedCheckerFailures("checker failed with exit code 1. private-secret\nChecker failed with exit code 1; private-path"), [1]);
  assert.deepEqual(reportedCheckerFailures("checker failed with exit code 1.5\nchecker failed with exit code 1wrong"), []);
  assert.deepEqual(reportedCheckerFailures("checker failed with exit code 1234567890.\nchecker failed with exit code -999."), []);
  assert.equal(reportedCheckerFailures(Array.from({ length: 20 }, (_, i) => `checker failed with exit code ${i}.`).join("\n")).length, 8);
});

test("diagnostic parser draining is bounded and reports incomplete rather than hanging cleanup", async () => {
  assert.equal(await settleDiagnosticParsers([{ chain: Promise.resolve() }], 10), true);
  assert.equal(await settleDiagnosticParsers([{ chain: Promise.reject(Error("private diagnostic failure")) }], 10), false);
  assert.equal(await settleDiagnosticParsers([{ chain: new Promise(() => {}) }], 1), false);
  assert.equal(await settleDiagnosticParsers([], 10), true);
});

test("task diagnostics retain fixed signals across redraws without retaining private text", () => {
  const diagnostic = {};
  recordTaskSignals(diagnostic, "Working (esc to interrupt) private@example.invalid C:/private/token", 15.9);
  recordTaskSignals(diagnostic, "Login expired. Please run /login token=secret", 30);
  recordTaskSignals(diagnostic, "Working", 45);
  recordTaskSignals(diagnostic, "", 50);
  recordTaskSignals(diagnostic, "new raw text", Number.NaN);
  const snapshot = taskSignalSnapshot(diagnostic);
  assert.deepEqual(snapshot.progressSignals, [{ signal: "working-footer", firstSeenMs: 15, lastSeenMs: 45 }]);
  assert.ok(snapshot.fixedErrorExcerpts.some((entry) => entry.signal === "Login expired" && entry.firstSeenMs === 30));
  assert.doesNotMatch(JSON.stringify(snapshot), /private|secret|example.invalid|token=/);
  assert.deepEqual(taskSignalSnapshot({}), { classifications: [], fixedErrorExcerpts: [], progressSignals: [] });
});

test("a local provider metadata fallback is not classified as a model refusing the task", () => {
  assert.deepEqual(codexProgressSignals("Model metadata for `fixture` not found. Defaulting to fallback metadata."), ["model-metadata-fallback"]);
  assert.deepEqual(codexProgressSignals("Model fixture unavailable"), ["model-refusal-or-unavailable"]);
});

test("composer hints never authorize input or leak a draft, path, or account", () => {
  const prompt = "Inspect the private fixture";
  const hints = composerHints(`private@example.invalid\nC:/private\n${prompt}\n› Ask Codex to do anything`, "› ", prompt);
  assert.equal(hints.cursorOnPromptLikeLine, true);
  assert.equal(hints.cursorOnEmptyPromptLikeLine, true);
  assert.equal(hints.emptyComposerPlaceholderVisible, true);
  assert.equal(hints.expectedPromptVisibleSomewhere, true);
  assert.equal(hints.authorizesInput, false);
  assert.equal(hints.source, "heuristic-rendered-terminal-hints");
  assert.doesNotMatch(JSON.stringify(hints), /private|example.invalid|Inspect/);
  assert.equal(composerHints("Please run /login", "not a composer", prompt).blockingPromptHintVisible, true);
  assert.equal(composerHints("", "", "").expectedPromptVisibleSomewhere, false);
});

test("terminal composer diagnostics use viewport and current cursor instead of assuming a transcript line is active", async () => {
  const renderer = new TerminalQueryResponder();
  try {
    await renderer.feed("› old transcript prompt\r\n› Ask Codex to do anything\r\n› ");
    const hints = renderer.composerHints("old transcript prompt");
    assert.equal(hints.cursorOnEmptyPromptLikeLine, true);
    assert.equal(hints.expectedPromptVisibleSomewhere, true);
    assert.equal(hints.authorizesInput, false);
    await renderer.feed("\x1b[2J\x1b[Hnot a composer");
    assert.equal(renderer.composerHints("old transcript prompt").expectedPromptVisibleSomewhere, false);
  } finally { renderer.dispose(); }
});

test("rendered answer history is diagnostic only and does not replace the current verification gate", async () => {
  const nonce = "88888888-2222-4333-8444-555555555555";
  const verifier = new McpReviewVerifier(nonce, 51);
  try {
    const prefix = `LATTICE_RESULT ${nonce} `;
    let evidence = await verifier.feed(`${prefix}00\x1b[${prefix.length + 1}G51`);
    assert.equal(evidence.correctRawNow, false);
    assert.equal(evidence.correctRenderedNow, true);
    evidence = await verifier.feed("\x1b[2J\x1b[Hredrawn");
    assert.equal(evidence.correctRenderedNow, false);
    assert.equal(evidence.correctRenderedEverSeen, true);
    assert.equal(evidence.correctRawEverSeen, false);
    assert.equal(evidence.correctNonceAndComputedValue, false);
    assert.doesNotMatch(JSON.stringify(evidence), /88888888|redrawn/);
  } finally { verifier.dispose(); }
});

test("Codex pair is explicit, excludes Claude/single mode, and requires an installed compiler path", () => {
  const paths = ["--lattice", "lattice.exe", "--codex", "codex.exe", "--rustc", "toolchain/bin/rustc.exe"];
  assert.equal(parseOptions(["--run-live", "--codex-pair", ...paths]).codexPair, true);
  assert.throws(() => parseOptions(["--run-live", "--codex-pair", "--lattice", "lattice.exe", "--codex", "codex.exe"]), /codex-pair-requires-native-rustc/);
  assert.throws(() => parseOptions(["--run-live", "--codex-pair", "--codex-only", ...paths]), /codex-pair-requires-live-without-claude/);
  assert.throws(() => parseOptions(["--run-live", "--codex-pair", "--claude", "claude.exe", ...paths]), /codex-pair-requires-live-without-claude/);
  assert.throws(() => parseOptions(["--run-live", "--codex-pair", "--trust-owned-fixture", ...paths]), /codex-pair-requires-live-without-claude/);
  assert.throws(() => parseOptions(["--preflight", "--codex-pair", ...paths]), /codex-pair-requires-live-without-claude/);
  assert.throws(() => parseOptions(["--run-live", "--codex-only", ...paths]), /compiler-options-require-codex-pair/);
});

test("pair worker IDs, review kinds and cancellation remain distinct for the same provider", () => {
  assert.deepEqual(liveWorkers({ codexPair: true }), [
    { id: "frontend", provider: "codex", kind: "frontend" },
    { id: "rust", provider: "codex", kind: "rust" },
  ]);
  assert.deepEqual(cancellationWorkers({ codexPair: true }), { target: "frontend", survivor: "rust" });
  assert.deepEqual(cancellationWorkers({ codexOnly: true }), { target: "codex", survivor: null });
  assert.deepEqual(cancellationWorkers({}), { target: "claude", survivor: "codex" });
  const reviews = { frontend: { status: "fulfilled" }, rust: { status: "fulfilled" } };
  assert.equal(cancelPrerequisiteFailure(reviews, false, true, true), null);
  assert.equal(cancelPrerequisiteFailure(reviews, false, false, true), "cancel-target-already-closed");
  assert.equal(cancelPrerequisiteFailure({ codex: { status: "fulfilled" } }, false, true, true), "cancel-review-prerequisites-failed");
});

test("pair pass needs both model reviews, independent compiler checks and cancellation isolation", () => {
  const checks = requiredLiveChecks(false, true).map((id) => ({ id, status: "passed" }));
  assert.equal(liveChecksPassed(checks, false, true), true);
  assert.equal(liveChecksPassed(checks, false, false), false);
  for (const id of ["native-compiler-inventory", "frontend-verified-review", "rust-verified-review", "frontend-compiler-preflight", "rust-compiler-preflight",
    "frontend-independent-compiler-check", "rust-independent-compiler-check", "mcp-session-cancel-isolation"]) {
    assert.equal(liveChecksPassed(checks.filter((check) => check.id !== id), false, true), false, id);
    assert.equal(liveChecksPassed(checks.map((check) => check.id === id ? { ...check, status: "failed" } : check), false, true), false, id);
  }
  assert.equal(checks.some((check) => check.id.includes("agent-compiler-executed")), false);
});

test("pair compiler plans never install, execute artifacts, or write compiler output files", () => {
  assert.deepEqual(pairCompilerArguments("frontend"), ["--noEmit", "--pretty", "false", "--project", "tsconfig.json"]);
  assert.deepEqual(pairCompilerArguments("rust"), ["--crate-name", "lattice_acceptance", "--crate-type", "lib", "--edition", "2021", "--emit=metadata", "-o", "-", "review.rs"]);
  assert.throws(() => pairCompilerArguments("unknown"), /unknown-compiler-worker/);
  for (const kind of ["frontend", "rust"]) {
    const prompt = pairPrompt(kind);
    assert.doesNotMatch(prompt, /[\r\n\t]/);
    assert.match(prompt, /run node checker\.mjs once as the only compiler command/);
    assert.match(prompt, /Read-only file inspection of this fixture is allowed; do not execute the source/);
    assert.match(prompt, /does not execute compiled code or write files/);
    assert.equal(verifiedResult(prompt, "88888888-2222-4333-8444-555555555555", 51), false);
  }
});

test("pair Codex policy remains read-only with no automatic approval, web search or login shell", () => {
  const args = pairCodexArguments("C:\\fresh\\frontend", ["-c", 'mcp_servers.fixture={enabled=false,command="inert"}']);
  assert.deepEqual(args.slice(0, 7), ["--sandbox", "read-only", "--ask-for-approval", "never", "--no-alt-screen", "--cd", "C:\\fresh\\frontend"]);
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(args.includes("allow_login_shell=false"));
  assert.equal(args.includes("workspace-write"), false);
  assert.equal(args.includes("danger-full-access"), false);
  assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
  assert.ok(args.includes('projects={"C:\\\\fresh\\\\frontend"={trust_level="trusted"}}'));
});

test("the generated checker captures bounded compiler metadata without logging paths or raw binary", () => {
  const script = pairCheckerScript("C:\\private-toolchain\\rustc.exe", { executableSha256: "a".repeat(64) }, "rust", "b".repeat(64));
  assert.match(script, /spawnSync\(config\.compiler, config\.args/);
  assert.match(script, /timeout: 30000, maxBuffer: 1024 \* 1024, shell: false/);
  assert.match(script, /sha\(readFileSync\(config\.compiler\)\) !== config\.compilerHash/);
  assert.match(script, /stdoutSha256: sha\(result\.stdout/);
  assert.match(script, /compiledCodeExecuted: false/);
  assert.doesNotMatch(script, /writeFile|mkdir|fetch\(|console\.log\(result\.stdout|compilerPath:/);
  assert.equal(script.includes('"-o","-"'), true);
});

test("independent compiler corroboration requires identity, source, exit and full bounded-output hash matches", () => {
  const before = { exitCode: 0, interrupted: false, compilerSha256: "compiler", sourceSha256: "source",
    stdoutBytes: 2749, stdoutSha256: "metadata", stderrBytes: 0, stderrSha256: "empty" };
  assert.equal(compilerResultMatches(before, { ...before }, "rust"), true);
  for (const [key, value] of Object.entries({ exitCode: 1, interrupted: true, compilerSha256: "other", sourceSha256: "changed",
    stdoutSha256: "different", stdoutBytes: 1, stderrBytes: 1, stderrSha256: "warning" })) {
    assert.equal(compilerResultMatches(before, { ...before, [key]: value }, "rust"), false, key);
  }
  const empty = { ...before, stdoutBytes: 0, stdoutSha256: "empty" };
  assert.equal(compilerResultMatches(empty, empty, "rust"), false);
  assert.equal(compilerResultMatches(empty, empty, "frontend"), true);
});

test("dual-worker acceptance cannot pass with missing, failed, or duplicated cancellation evidence", () => {
  const checks = requiredLiveChecks(false).map((id) => ({ id, status: "passed" }));
  assert.equal(liveChecksPassed(checks), true);
  assert.equal(liveChecksPassed([]), false);
  assert.equal(liveChecksPassed(checks.filter((check) => check.id !== "mcp-session-cancel-isolation")), false);
  for (const status of ["failed", "blocked", "skipped"]) {
    assert.equal(liveChecksPassed(checks.map((check) => check.id === "mcp-session-cancel-isolation" ? { ...check, status } : check)), false);
  }
  assert.equal(liveChecksPassed([...checks, { id: "mcp-session-cancel-isolation", status: "passed" }]), false);
});

test("a target closed after both reviews cannot silently skip cancellation", () => {
  const successful = { claude: { status: "fulfilled" }, codex: { status: "fulfilled" } };
  assert.equal(cancelPrerequisiteFailure(successful, false, true), null);
  assert.equal(cancelPrerequisiteFailure(successful, false, false), "cancel-target-already-closed");
  assert.equal(cancelPrerequisiteFailure({ codex: successful.codex }, false, true), "cancel-review-prerequisites-failed");
  assert.equal(cancelPrerequisiteFailure({ ...successful, claude: { status: "rejected" } }, false, true), "cancel-review-prerequisites-failed");
});

test("Codex-only acceptance requires its own cancellation but never proves two-worker isolation", () => {
  const checks = requiredLiveChecks(true).map((id) => ({ id, status: "passed" }));
  assert.equal(liveChecksPassed(checks, true), true);
  assert.equal(liveChecksPassed(checks, false), false);
  assert.equal(liveChecksPassed(checks.filter((check) => check.id !== "mcp-session-cancel"), true), false);
  assert.equal(checks.some((check) => /claude|two-isolated|parallel|isolation/.test(check.id)), false);
  assert.equal(cancelPrerequisiteFailure({ codex: { status: "fulfilled" } }, true, true), null);
  assert.equal(cancelPrerequisiteFailure({ codex: { status: "fulfilled" } }, true, false), "cancel-target-already-closed");
});

test("cleanup confirms each owned CLI PID independently of launcher exit or closed events", () => {
  const probed = [];
  const probe = (pid) => {
    probed.push(pid);
    if (pid === 11001) throw Object.assign(Error("gone"), { code: "ESRCH" });
    if (pid === 11003) throw Object.assign(Error("access denied"), { code: "EPERM" });
  };
  assert.deepEqual(ownedCliCleanupEvidence([11001, 11002, 11003, undefined, -1], probe), {
    sessionCount: 5, exited: 1, stillRunning: 1, unknown: 3, confirmed: false,
  });
  assert.deepEqual(probed, [11001, 11002, 11003]);
  assert.equal(ownedCliCleanupEvidence([11001, 11001], probe).confirmed, true);
  assert.equal(ownedCliCleanupEvidence([], probe).confirmed, true);
  assert.equal(ownedCliCleanupEvidence([undefined], probe).confirmed, false);
  assert.equal(JSON.stringify(ownedCliCleanupEvidence([11002], probe)).includes("11002"), false);
});

test("MCP review evidence ignores desktop-only answers and requires authorized raw MCP bytes", async () => {
  const nonce = "88888888-2222-4333-8444-555555555555";
  const desktop = new TerminalQueryResponder();
  const mcp = new McpReviewVerifier(nonce, 51);
  try {
    assert.deepEqual(MCP_REVIEW_OUTPUT_OPTIONS, { maxBytes: 65536, stripControlSequences: false });
    await desktop.feed(`LATTICE_RESULT ${nonce} 51\r\n`);
    assert.equal(verifiedResult(desktop.screenText(), nonce, 51), true);
    assert.equal((await mcp.feed(reviewPrompt("claude"))).correctNonceAndComputedValue, false);
    assert.equal((await mcp.feed(`\r\nLATTICE_RESULT ${nonce} 17\r\n`)).correctNonceAndComputedValue, false);
    const evidence = await mcp.feed(`LATTICE_RESULT ${nonce} 51\r\n`);
    assert.equal(evidence.correctNonceAndComputedValue, true);
    assert.equal(evidence.source, "mcp-raw-output-and-renderer");
    assert.equal(evidence.stripControlSequences, false);
    assert.equal(JSON.stringify(evidence).includes(nonce), false);
    assert.equal(JSON.stringify(evidence).includes("LATTICE_RESULT"), false);
  } finally { desktop.dispose(); mcp.dispose(); }
});

test("the evidence renderer handles MCP TUI cursor updates without returning terminal replies", async () => {
  const nonce = "88888888-2222-4333-8444-555555555555";
  const prefix = `LATTICE_RESULT ${nonce} `;
  const raw = `${prefix}00\x1b[${prefix.length + 1}G51\x1b[6n`;
  const mcp = new McpReviewVerifier(nonce, 51);
  try {
    assert.equal(verifiedResult(raw, nonce, 51), false);
    const evidence = await mcp.feed(raw);
    assert.equal(evidence.correctNonceAndComputedValue, true);
    assert.equal(Array.isArray(evidence), false);
    assert.equal(JSON.stringify(evidence).includes("\\u001b"), false);
  } finally { mcp.dispose(); }
});

test("native input probe uses crossterm raw-mode flags and metadata-only bounded capture", () => {
  const script = nativeInputProbeScript("INPUT_PROBE");
  assert.match(script, /original & ~7u/);
  assert.match(script, /ReadConsoleInputW/);
  assert.match(script, /ElapsedMilliseconds<10000/);
  assert.match(script, /finally \{SetConsoleMode\(handle,original\)/);
  assert.doesNotMatch(script, /WriteLine\(actual|Write\(actual/);
  assert.equal(parseOptions(["--input-preflight", "--lattice", "lattice.exe"]).mode, "input-preflight");
});

test("Codex diagnosis distinguishes a command approval from model work without exposing command text", () => {
  assert.deepEqual(codexProgressSignals("Working (esc to interrupt)"), ["working-footer"]);
  const prompt = "Would you like to run the following command? powershell Get-Content C:/private --secret=private";
  assert.deepEqual(codexProgressSignals(prompt), ["powershell-file-read", "needs-user-action"]);
  assert.deepEqual(taskFailureSignals(prompt), ["Would you like to run the following command"]);
  assert.deepEqual(codexProgressSignals("[Pasted Content 450 chars]\nenter to send"), ["pasted-content-placeholder", "enter-to-send"]);
  assert.equal(JSON.stringify(codexProgressSignals(prompt)).includes("private"), false);
});

test("lifecycle metadata keeps actual sources and phases without duplicate polling entries", () => {
  const diagnostic = {};
  recordLifecycle(diagnostic, "idle", "integration");
  recordLifecycle(diagnostic, "idle", "integration");
  diagnostic.phase = "review";
  recordLifecycle(diagnostic, "working", "heuristic");
  recordLifecycle(diagnostic, "working", "integration");
  recordLifecycle(diagnostic, "done", "integration");
  recordLifecycle(diagnostic, "unknown-account-text", "integration");
  assert.deepEqual(diagnostic.lifecycleSequence, [
    { state: "idle", source: "integration", phase: "startup" },
    { state: "working", source: "heuristic", phase: "review" },
    { state: "working", source: "integration", phase: "review" },
    { state: "done", source: "integration", phase: "review" },
  ]);
  for (let i = 0; i < 600; i++) recordLifecycle(diagnostic, i % 2 ? "working" : "done", "integration");
  assert.equal(diagnostic.lifecycleSequence.length, 256);
  assert.equal(diagnostic.lifecycleSequenceTruncated, true);
});

test("task-only rendered diagnostics exclude startup hints and expose fixed error excerpts", async () => {
  const startup = new TerminalQueryResponder();
  const task = new TerminalQueryResponder();
  try {
    await startup.feed("Welcome. Please run /login for another account\r\n");
    await task.feed("LATTICE_RESULT private-test-value 51\r\n");
    assert.deepEqual(taskFailureSignals(task.screenText()), []);
    assert.deepEqual(classifyProviderOutput(task.screenText()), []);
    await task.feed("\x1b[1mLogin expired\x1b[0m. Please run /login private@example.invalid C:/private token=secret\r\n");
    assert.deepEqual(taskFailureSignals(task.screenText()), ["Login expired", "Please run /login"]);
    assert.equal(JSON.stringify(taskFailureSignals(task.screenText())).includes("private"), false);
    assert.equal(JSON.stringify(taskFailureSignals(task.screenText())).includes("secret"), false);
  } finally { startup.dispose(); task.dispose(); }
});

test("fixture trust requires an exact directory line and highlighted known consent option", () => {
  const directory = "C:\\fresh-fixture\\work";
  const screen = `Accessing workspace:\n${directory}\nDo you trust the files in this folder?\n❯ 1. Yes, I trust this folder`;
  assert.equal(ownedFixtureTrustReady(screen, directory), true);
  assert.equal(ownedFixtureTrustReady(screen.replace(directory, `${directory}\\unrelated`), directory), false);
  assert.equal(ownedFixtureTrustReady(screen.replace("❯ 1.", "  1."), directory), false);
  assert.equal(ownedFixtureTrustReady(screen.replace("Yes, I trust this folder", "Yes, approve every command"), directory), false);
  assert.equal(ownedFixtureTrustReady(`Log in\n${directory}\n❯ Yes, proceed`, directory), false);
});

test("Codex fixture trust encodes dotted Windows paths inside the TOML value", () => {
  assert.deepEqual(fixtureTrustArguments("C:\\fixture.with.dots\\known work"), ["-c", 'projects={"C:\\\\fixture.with.dots\\\\known work"={trust_level="trusted"}}']);
});

test("terminal queries are answered across every chunk split without sending user input", async () => {
  const query = "\x1b[6n\x1b[c\x1b[>0c\x1b]10;?\x07\x1b]11;?\x1b\\\x1b[?2026$p";
  const expected = ["\x1b[1;1R", "\x1b[?1;2c", "\x1b[>0;276;0c", "\x1b]10;rgb:dddd/dddd/dddd\x1b\\", "\x1b]11;rgb:1818/1818/1818\x1b\\", "\x1b[?2026;2$y"];
  for (let split = 0; split <= query.length; split++) {
    const responder = new TerminalQueryResponder();
    try {
      assert.deepEqual([...await responder.feed(query.slice(0, split)), ...await responder.feed(query.slice(split))], expected);
      assert.deepEqual(await responder.feed("normal prompt: press Enter\x1b]52;c;?\x07"), []);
      assert.deepEqual(await responder.feed("\x1b[?2026h\x1b[?2026$p"), ["\x1b[?2026;1$y"]);
      assert.equal(responder.counts["mode-status"], 2);
      assert.match(responder.screenText(), /normal prompt: press Enter/);
      assert.deepEqual(await responder.feed("\x1b[5;8H\x1b[6n"), ["\x1b[5;8R"]);
    } finally { responder.dispose(); }
  }
});

test("native loader failures are classified without blaming accounts", () => {
  assert.equal(nativeExitClassification(3221225495), "native-status-no-memory");
  assert.equal(nativeExitClassification(-1073741511), "native-entrypoint-not-found");
  assert.equal(nativeExitClassification(1), null);
});

test("startup diagnostics expose only fixed classifications, never raw user data", () => {
  const output = "Unknown option --tools at C:/private/user with token secret-value\nSessionStart hook error\nPlease /login user@example.invalid";
  const codes = classifyProviderOutput(output);
  assert.ok(codes.includes("unsupported-tools"));
  assert.ok(codes.includes("hook-or-settings-error"));
  assert.ok(codes.includes("authentication-required"));
  assert.equal(JSON.stringify(codes).includes("secret-value"), false);
  assert.equal(JSON.stringify(codes).includes("private/user"), false);
  assert.equal(JSON.stringify(codes).includes("example.invalid"), false);
  assert.ok(classifyProviderOutput("Quick \x1b[1msafety check\x1b[0m: Is this a project you created or one you trust?").includes("workspace-trust-required"));
  assert.ok(classifyProviderOutput("Choose the text style for your terminal").includes("onboarding-theme-required"));
  assert.deepEqual(startupSignals("Warning: account private@example.invalid at C:/sensitive-private with secret-value"), ["warning", "account"]);
});

test("Codex MCP is disabled per server instead of an ineffective empty table", () => {
  assert.deepEqual(disabledMcpArguments([{ name: "fixture-mcp", enabled: true }]), ["-c", 'mcp_servers.fixture-mcp={enabled=false,command="latticeterm-live-acceptance-disabled"}']);
  assert.deepEqual(disabledMcpArguments([]), []);
  assert.throws(() => disabledMcpArguments([{ name: "unsafe.name" }]), /codex-mcp-name-unsupported/);
  assert.throws(() => disabledMcpArguments([{ name: "control\nkey" }]), /codex-mcp-name-unsupported/);
  assert.throws(() => disabledMcpArguments({ servers: [] }), /codex-mcp-inventory-invalid/);
});

test("live models require an explicit mutually exclusive mode", () => {
  const paths = ["--lattice", "lattice.exe", "--claude", "claude.exe", "--codex", "codex.exe"];
  assert.throws(() => parseOptions(paths), /missing-required-option/);
  assert.throws(() => parseOptions(["--preflight", "--run-live", ...paths]), /ambiguous-mode/);
  assert.equal(parseOptions(["--preflight", ...paths]).mode, "preflight");
  assert.equal(parseOptions(["--run-live", ...paths]).mode, "run-live");
  assert.equal(parseOptions(["--run-live", "--codex-only", "--lattice", "lattice.exe", "--codex", "codex.exe"]).codexOnly, true);
  assert.throws(() => parseOptions(["--run-live", "--codex-only", ...paths]), /codex-only-requires-live-without-claude/);
  assert.throws(() => parseOptions(["--preflight", "--codex-only", "--lattice", "lattice.exe", "--codex", "codex.exe"]), /codex-only-requires-live-without-claude/);
  assert.equal(parseOptions(["--run-live", "--trust-owned-fixture", ...paths]).trustOwnedFixture, true);
  assert.throws(() => parseOptions(["--preflight", "--trust-owned-fixture", ...paths]), /fixture-trust-requires-live-mode/);
  assert.equal(parseOptions(["--runtime-preflight", "--lattice", "lattice.exe"]).mode, "runtime-preflight");
  assert.throws(() => parseOptions(["--runtime-preflight", ...paths]), /runtime-preflight-does-not-use-providers/);
  assert.throws(() => parseOptions(["--run-live", ...paths, "--timeout-seconds", "99999"]), /invalid-timeout/);
  assert.throws(() => parseOptions(["--run-live", ...paths, "--claude", "other.exe"]), /duplicate-option/);
});

test("orchestrator independently computes the two distinct fixture answers", () => {
  const fixture = makeFixtures("88888888-2222-4333-8444-555555555555", [2, 3, 5, 7]);
  assert.deepEqual(fixture.scores, { claude: 51, codex: 17 });
  assert.match(fixture.files["review.ts"], /values\.reduce/);
  assert.match(fixture.files["review.rs"], /index % 2 == 0/);
  for (const provider of ["claude", "codex"]) {
    const prompt = reviewPrompt(provider);
    assert.equal(prompt.includes(fixture.nonce), false);
    assert.equal(verifiedResult(prompt, fixture.nonce, fixture.scores[provider]), false);
    assert.equal(verifiedResult(`LATTICE_RESULT ${fixture.nonce} ${fixture.scores[provider]}`, fixture.nonce, fixture.scores[provider]), true);
  }
});

test("completion cannot be faked by prompt echo, exit status, or a wrong answer", () => {
  const nonce = "88888888-2222-4333-8444-555555555555";
  assert.equal(verifiedResult("Process exited with code 0", nonce, 51), false);
  assert.equal(verifiedResult("LATTICE_RESULT <nonce> <integer>", nonce, 51), false);
  assert.equal(verifiedResult(`LATTICE_RESULT ${nonce} 17`, nonce, 51), false);
  assert.equal(verifiedResult(`LATTICE_RESULT ${nonce} 510`, nonce, 51), false);
  assert.equal(verifiedResult(`LATTICE_RESULT ${nonce} 51.5`, nonce, 51), false);
  assert.equal(verifiedResult(`LATTICE_RESULT ${nonce} 51wrong`, nonce, 51), false);
  assert.equal(verifiedResult("LATTICE_RESULT 77777777-2222-4333-8444-555555555555 51", nonce, 51), false);
  assert.equal(verifiedResult(`LATTICE_RESULT\n${nonce}\n51`, nonce, 51), true);
});

test("read-only acceptance notices changed and newly created files", () => {
  const root = mkdtempSync(join(tmpdir(), "lattice-mcp-live-unit-"));
  try {
    writeFileSync(join(root, "review.ts"), "original", { flag: "wx" });
    const original = fixtureSnapshot(root);
    writeFileSync(join(root, "review.ts"), "changed");
    assert.notDeepEqual(fixtureSnapshot(root), original);
    writeFileSync(join(root, "review.ts"), "original");
    writeFileSync(join(root, "new.txt"), "unexpected", { flag: "wx" });
    assert.notDeepEqual(fixtureSnapshot(root), original);
    assert.throws(() => parseOptions(["--preflight", "--lattice", "l.exe", "--claude", "c.exe", "--codex", "x.exe", "--report", join(root, "new.txt")]), /report-already-exists/);
  } finally {
    // Exact directory returned by mkdtemp, never a caller-supplied target.
    rmSync(root, { recursive: true, force: true });
  }
});
