// Opt-in Windows acceptance using real Claude Code and Codex Fleet sessions.
// Preflight never launches a model. Live mode can consume the logged-in accounts'
// quota and creates normal provider session history; it does not change logins.
// Usage:
// node scripts/verify-mcp-live-agents.mjs --preflight --lattice <exe> --claude <exe> --codex <exe>
// Replace --preflight with --run-live to opt in, optionally --report <new.json>.
// --runtime-preflight --lattice <exe> needs no AI CLI or account: it checks
// Windows cmd, PowerShell, and this Node runtime in real owned ConPTY sessions.
// --trust-owned-fixture allows one recognized Claude trust confirmation for the
// exact new fixture; Claude may persist that project trust in its own settings.
// No authentication or unrelated permission prompt is answered. Codex has no initial
// official idle notification: its real bootstrap turn must complete first.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { createRequire } from "node:module";
import { arch, release, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

const { Terminal } = createRequire(import.meta.url)("@xterm/xterm");

const MAX_LINE = 1024 * 1024;
const BOOTSTRAP = "Do not use tools, read files, change files, or start background work. Reply with just READY.";
const USAGE = "Pass exactly one of --preflight, --pty-preflight, --runtime-preflight, --input-preflight, or --run-live, and --lattice <native.exe>. Runtime/input preflight need no providers; the other modes require --claude and --codex native executable paths. Live --codex-only omits Claude. Live --codex-pair uses two Codex workers and requires --rustc <installed-native-rustc.exe>; --tsc <native-tsc.exe> is optional when repository TypeScript 7 is installed. Optional: --report <new.json>, --timeout-seconds <30..600>, --trust-owned-fixture (Claude dual-live only).";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (code) => { throw Error(code); };

export function parseOptions(args) {
  const options = { timeoutSeconds: 180 };
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (["--preflight", "--pty-preflight", "--runtime-preflight", "--input-preflight", "--run-live"].includes(name)) {
      if (options.mode) fail("ambiguous-mode");
      options.mode = name.slice(2);
    } else if (name === "--trust-owned-fixture") {
      if (options.trustOwnedFixture) fail("duplicate-option");
      options.trustOwnedFixture = true;
    } else if (name === "--codex-only") {
      if (options.codexOnly) fail("duplicate-option");
      options.codexOnly = true;
    } else if (name === "--codex-pair") {
      if (options.codexPair) fail("duplicate-option");
      options.codexPair = true;
    } else if (["--lattice", "--claude", "--codex", "--tsc", "--rustc", "--report", "--timeout-seconds"].includes(name)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) fail("missing-option-value");
      const key = name === "--timeout-seconds" ? "timeoutSeconds" : name.slice(2);
      if (key !== "timeoutSeconds" && key in options) fail("duplicate-option");
      options[key] = key === "timeoutSeconds" ? Number(value) : resolve(value);
    } else fail("unknown-option");
  }
  const noProviders = ["runtime-preflight", "input-preflight"].includes(options.mode);
  if (!options.mode || !options.lattice || (!noProviders && ((!options.codexOnly && !options.codexPair && !options.claude) || !options.codex))) fail("missing-required-option");
  if (noProviders && (options.claude || options.codex)) fail("runtime-preflight-does-not-use-providers");
  if (options.trustOwnedFixture && options.mode !== "run-live") fail("fixture-trust-requires-live-mode");
  if (options.codexOnly && (options.mode !== "run-live" || options.claude || options.trustOwnedFixture)) fail("codex-only-requires-live-without-claude");
  if (options.codexPair && (options.mode !== "run-live" || options.claude || options.codexOnly || options.trustOwnedFixture)) fail("codex-pair-requires-live-without-claude");
  if (options.codexPair && !options.rustc) fail("codex-pair-requires-native-rustc");
  if (!options.codexPair && (options.tsc || options.rustc)) fail("compiler-options-require-codex-pair");
  if (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds < 30 || options.timeoutSeconds > 600) fail("invalid-timeout");
  if (options.report && existsSync(options.report)) fail("report-already-exists");
  return options;
}

export function makeFixtures(nonce = randomUUID(), values = Array.from({ length: 4 }, () => randomInt(2, 20))) {
  const ts = `export const nonce = ${JSON.stringify(nonce)};\nexport const sample = ${JSON.stringify(values)};\nexport function score(values: number[]): number {\n  return values.reduce((sum, value, index) => sum + value * (index + 1), 0);\n}\n`;
  const rust = `pub const NONCE: &str = ${JSON.stringify(nonce)};\npub const SAMPLE: [i32; 4] = [${values.join(", ")}];\npub fn score(values: &[i32]) -> i32 {\n    values.iter().enumerate().filter(|(index, _)| index % 2 == 0)\n        .map(|(index, value)| (index as i32 + 1) * value).sum()\n}\n`;
  return {
    files: { "review.ts": ts, "review.rs": rust }, nonce,
    scores: {
      claude: values.reduce((sum, value, index) => sum + value * (index + 1), 0),
      codex: values.reduce((sum, value, index) => sum + (index % 2 === 0 ? value * (index + 1) : 0), 0),
    },
  };
}

export function reviewPrompt(provider) {
  const file = provider === "claude" ? "review.ts" : "review.rs";
  return `Read only ${file} in the current directory. Do not read other files, modify anything, use network tools, execute the code, or start background work. Calculate score(sample) for TypeScript or score(&SAMPLE) for Rust by inspecting the source. Return one plain line in this form, replacing both placeholders with the values you obtained from the file: LATTICE_RESULT <nonce> <integer>. Do not repeat this request.`;
}

export function liveWorkers(options) {
  return options.codexPair
    ? [{ id: "frontend", provider: "codex", kind: "frontend" }, { id: "rust", provider: "codex", kind: "rust" }]
    : (options.codexOnly ? ["codex"] : ["claude", "codex"])
      .map((provider) => ({ id: provider, provider, kind: provider === "claude" ? "frontend" : "rust" }));
}

export function cancellationWorkers(options) {
  return options.codexPair ? { target: "frontend", survivor: "rust" }
    : options.codexOnly ? { target: "codex", survivor: null } : { target: "claude", survivor: "codex" };
}

export function pairCompilerArguments(kind) {
  if (kind === "frontend") return ["--noEmit", "--pretty", "false", "--project", "tsconfig.json"];
  if (kind === "rust") return ["--crate-name", "lattice_acceptance", "--crate-type", "lib", "--edition", "2021", "--emit=metadata", "-o", "-", "review.rs"];
  fail("unknown-compiler-worker");
}

export function pairPrompt(kind) {
  if (!["frontend", "rust"].includes(kind)) fail("unknown-compiler-worker");
  const file = kind === "frontend" ? "review.ts" : "review.rs";
  const expression = kind === "frontend" ? "score(sample)" : "score(&SAMPLE)";
  return `In this new read-only fixture, run node checker.mjs once as the only compiler command. Read-only file inspection of this fixture is allowed; do not execute the source. The checker captures bounded output and does not execute compiled code or write files. Do not install packages, use network tools, read other directories, modify files, or start background work. Then inspect ${file} and calculate ${expression}. Return one plain line LATTICE_RESULT <nonce> <integer>, replacing both placeholders using the source. Do not repeat this request. If the checker is denied or fails, mention that briefly, but continue the permitted source inspection and still include the LATTICE_RESULT line. Do not request broader permissions.`;
}

export function pairCodexArguments(directory, mcpArguments) {
  return ["--sandbox", "read-only", "--ask-for-approval", "never", "--no-alt-screen", "--cd", directory,
    "-c", 'web_search="disabled"', "-c", "allow_login_shell=false",
    ...mcpArguments, ...fixtureTrustArguments(directory), BOOTSTRAP];
}

export function pairCheckerScript(compiler, identity, kind, sourceHash) {
  const config = { compiler, compilerHash: identity.executableSha256, kind,
    source: kind === "frontend" ? "review.ts" : "review.rs", sourceHash, args: pairCompilerArguments(kind) };
  return `import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const config = ${JSON.stringify(config)};
const cwd = dirname(fileURLToPath(import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (sha(readFileSync(config.compiler)) !== config.compilerHash || sha(readFileSync(join(cwd, config.source))) !== config.sourceHash) {
  console.log("LATTICE_COMPILER_CHECK identity-or-source-changed"); process.exitCode = 1;
} else {
  const result = spawnSync(config.compiler, config.args, { cwd, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024, shell: false });
  console.log("LATTICE_COMPILER_CHECK " + JSON.stringify({ kind: config.kind, exitCode: result.status,
    compilerSha256: config.compilerHash, sourceSha256: config.sourceHash,
    stdoutBytes: result.stdout?.length || 0, stdoutSha256: sha(result.stdout || ""),
    stderrBytes: result.stderr?.length || 0, stderrSha256: sha(result.stderr || ""),
    compilerResultCaptured: !result.error, compiledCodeExecuted: false }));
  process.exitCode = result.status === 0 && !result.error ? 0 : 1;
}
`;
}

export function compilerResultMatches(before, after, kind) {
  return before.exitCode === 0 && after.exitCode === 0 && !before.interrupted && !after.interrupted
    && before.compilerSha256 === after.compilerSha256 && before.sourceSha256 === after.sourceSha256
    && before.stdoutSha256 === after.stdoutSha256 && before.stdoutBytes === after.stdoutBytes
    && before.stderrSha256 === after.stderrSha256 && before.stderrBytes === after.stderrBytes
    && (kind !== "rust" || after.stdoutBytes > 0);
}

export function verifiedResult(text, nonce, expected) {
  // Neither the random nonce nor the computed answer occurs in the prompt.
  // TUI wrapping may put whitespace between the fixed fields. Sentence
  // punctuation may precede an honest checker-failure explanation; it must
  // not turn a decimal, thousands separator, or word suffix into an integer.
  const matches = [...text.matchAll(/LATTICE_RESULT\s+([0-9a-f-]{36})\s+(-?\d+)(?=\s|$|[;.,:](?=\s|$))/g)];
  return matches.some((match) => match[1] === nonce && Number(match[2]) === expected);
}

export function reportedCheckerFailures(text) {
  const codes = [...text.matchAll(/checker\s+failed(?:\s+with)?\s*[:;,-]?\s*exit\s+code\s+(-?\d{1,10})(?=\s|$|[;.,:](?=\s|$))/gi)]
    .map((match) => Number(match[1])).filter((code) => code >= -1 && code <= 255);
  return [...new Set(codes)].slice(0, 8);
}

export function requiredLiveChecks(codexOnly = false, codexPair = false) {
  const providers = codexPair ? ["frontend", "rust"] : codexOnly ? ["codex"] : ["claude", "codex"];
  return ["native-provider-inventory", "codex-configured-mcp-disabled-for-test-invocation",
    codexOnly ? "one-isolated-real-codex-session" : "two-isolated-real-cli-sessions",
    ...providers.map((provider) => `${provider}-official-readiness`),
    codexOnly ? "mcp-codex-dispatch" : "mcp-parallel-dispatch",
    ...providers.map((provider) => `${provider}-verified-review`),
    ...(codexPair ? ["native-compiler-inventory", "frontend-compiler-preflight", "rust-compiler-preflight", "frontend-independent-compiler-check", "rust-independent-compiler-check"] : []),
    "read-only-fixture-integrity",
    codexOnly ? "mcp-session-cancel" : "mcp-session-cancel-isolation",
    codexOnly ? "cancellation-revoked-sharing" : "revocation"];
}

export function liveChecksPassed(checks, codexOnly = false, codexPair = false) {
  const required = requiredLiveChecks(codexOnly, codexPair);
  return checks.every((check) => check.status === "passed")
    && required.every((id) => checks.filter((check) => check.id === id && check.status === "passed").length === 1);
}

export function cancelPrerequisiteFailure(reviewsByProvider, codexOnly, targetAlive, codexPair = false) {
  const providers = codexPair ? ["frontend", "rust"] : codexOnly ? ["codex"] : ["claude", "codex"];
  if (providers.some((provider) => reviewsByProvider[provider]?.status !== "fulfilled")) return "cancel-review-prerequisites-failed";
  return targetAlive ? null : "cancel-target-already-closed";
}

export function ownedCliCleanupEvidence(processIds, probe = (pid) => process.kill(pid, 0)) {
  const evidence = { sessionCount: processIds.length, exited: 0, stillRunning: 0, unknown: 0, confirmed: false };
  for (const pid of processIds) {
    if (!Number.isInteger(pid) || pid <= 0) { evidence.unknown++; continue; }
    try { probe(pid); evidence.stillRunning++; }
    catch (error) {
      if (error.code === "ESRCH") evidence.exited++;
      else evidence.unknown++;
    }
  }
  evidence.confirmed = evidence.exited === evidence.sessionCount;
  return evidence;
}

export function fixtureSnapshot(directory) {
  const names = readdirSync(directory).sort();
  if (names.length > 16) fail("unexpected-workspace-files");
  return names.map((name) => {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) fail("unexpected-workspace-entry");
    return [name, sha(readFileSync(path))];
  });
}

export function disabledMcpArguments(servers) {
  if (!Array.isArray(servers) || servers.length > 128) fail("codex-mcp-inventory-invalid");
  return servers.flatMap((server) => {
    // Names stay only in local process arguments, never in the report. Fail
    // closed on a name that needs TOML escaping instead of guessing its shape.
    if (!server || typeof server.name !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(server.name)) fail("codex-mcp-name-unsupported");
    // A partial per-server override can replace the transport table in newer
    // Codex releases. Supply a complete DISABLED inert transport, without
    // copying the real server's command, URL, environment, or credentials.
    return ["-c", `mcp_servers.${server.name}={enabled=false,command="latticeterm-live-acceptance-disabled"}`];
  });
}

export function fixtureTrustArguments(directory) {
  // Codex 0.153.4 splits override keys on '.' without TOML key unquoting.
  // Put the quoted Windows path in the TOML VALUE, not the dotted key.
  return ["-c", `projects={${JSON.stringify(directory)}={trust_level="trusted"}}`];
}

export function ownedFixtureTrustReady(screen, directory) {
  const plain = stripVTControlCharacters(screen).replaceAll("\\\\?\\", "").replaceAll("/", "\\");
  const expected = directory.replaceAll("\\\\?\\", "").replaceAll("/", "\\");
  const pathPresent = plain.split(/\r?\n/).some((line) => line.trim().toLowerCase() === expected.toLowerCase());
  return pathPresent && /trust (?:the |this )?(?:folder|files|workspace|authors)|accessing workspace/i.test(plain)
    && /[❯›>]\s*(?:1[.)]\s*)?Yes, (?:I trust this folder|proceed)\b/i.test(plain);
}

export function classifyProviderOutput(text) {
  text = stripVTControlCharacters(text);
  const classes = new Set();
  const patterns = [
    ["cli-argument-error", /unknown (?:option|argument)|unexpected argument|invalid (?:option|argument)|can only be used|requires? (?:a|an) (?:value|argument)|missing required/i],
    ["authentication-required", /not logged in|login required|please (?:run )?\/?login|oauth|token (?:has )?expired|invalid api key|authentication (?:failed|required)/i],
    ["hook-or-settings-error", /hook.{0,80}(?:error|fail)|(?:invalid|failed to (?:read|parse|load)).{0,80}(?:hook|settings|configuration)/i],
    ["workspace-trust-required", /trust (?:the |this )?(?:folder|directory|workspace|authors|contents)|do you trust|untrusted (?:folder|directory|workspace)|is this a project you created|quick safety check|do you recognize the files/i],
    ["onboarding-theme-required", /choose (?:the |a |your )?(?:text style|theme)|select (?:the |a |your )?theme|let.s get started/i],
    ["startup-confirmation-required", /press enter to continue|enter to confirm|press (?:enter|return) to (?:proceed|start)/i],
    ["permission-required", /permission (?:required|denied)|approval required|do you (?:want to )?allow/i],
    ["native-runtime-error", /entry point|entrypoint|0xc0000139|DLL.{0,80}(?:not found|missing)|module could not be found/i],
    ["terminal-unavailable", /not a (?:tty|terminal)|requires? (?:a |an )?(?:interactive )?terminal|stdin is not a terminal|raw mode is not supported/i],
    ["service-or-network-error", /connection (?:refused|timed out)|network (?:error|unavailable)|failed to connect|rate limit|quota exceeded|overloaded/i],
  ];
  for (const [name, expression] of patterns) if (expression.test(text)) classes.add(name);
  for (const option of ["setting-sources", "tools", "allowedTools", "disable-slash-commands", "strict-mcp-config", "mcp-config", "settings", "sandbox", "ask-for-approval", "no-alt-screen"]) {
    if (new RegExp(`(?:unknown|unexpected|invalid) (?:option|argument)[^\\n]{0,80}--${option}\\b`, "i").test(text)) classes.add(`unsupported-${option.toLowerCase()}`);
  }
  return [...classes].sort();
}

export function nativeExitClassification(code) {
  return ({
    0xc0000017: "native-status-no-memory",
    0xc0000139: "native-entrypoint-not-found",
    0xc0000135: "native-dll-not-found",
    0xc000007b: "native-invalid-image-format",
    0xc0000005: "native-access-violation",
    0xc0000142: "native-dll-init-failed",
  })[Number(code) >>> 0] || null;
}

export function startupSignals(text) {
  const plain = stripVTControlCharacters(text).toLowerCase();
  // An allowlist for unexpected startup screens, not a redacted transcript:
  // only these fixed phrases can leave the bounded in-memory diagnostic tail.
  return ["log in", "login", "sign in", "claude account", "subscription", "api key", "browser",
    "theme", "terminal", "trust", "directory", "workspace", "folder", "settings", "hook", "error",
    "warning", "account", "welcome", "setup", "continue", "enter", "select", "choose", "color",
    "permission", "terms", "privacy", "security", "notice", "update", "upgrade", "sandbox",
    "windows", "powershell", "approved", "allow", "run command", "no tty", "unrecognized"]
    .filter((phrase) => new RegExp(`\\b${phrase}\\b`, "i").test(plain));
}

export function taskFailureSignals(text) {
  // Fixed diagnostic excerpts only. Never copy a captured value, account,
  // response body, URL, file path, or token into the acceptance report.
  const plain = stripVTControlCharacters(text);
  return [
    ["Not logged in", /not logged in/i],
    ["Login expired", /login expired/i],
    ["Please run /login", /please (?:run )?\/login/i],
    ["Failed to refresh OAuth token", /failed to refresh oauth token/i],
    ["Invalid API key", /invalid api key/i],
    ["Authentication failed", /authentication failed/i],
    ["Credit balance is too low", /credit balance is too low/i],
    ["Usage limit reached", /(?:reached|hit) your (?:usage )?limit|usage limit reached/i],
    ["Rate limit exceeded", /rate limit (?:exceeded|reached)/i],
    ["Permission required", /permission required|approval required/i],
    ["Do you want to allow", /do you (?:want to )?allow/i],
    ["Would you like to run the following command", /would you like to run the following command/i],
    ["Approve this command", /approve this command|approve (?:once|for this session)/i],
  ].filter(([, expression]) => expression.test(plain)).map(([fixed]) => fixed);
}

export function codexProgressSignals(text) {
  const plain = stripVTControlCharacters(text);
  return [
    ["working-footer", /\bWorking(?:[ .…(]|$)|esc to interrupt/i],
    ["reconnecting", /reconnecting|stream disconnected/i],
    ["command-running-or-ran", /\b(?:Running|Ran)\b/],
    ["powershell-file-read", /Get-Content|\bpowershell\b/i],
    ["command-failed", /command (?:failed|not found)|not recognized as|cannot find path|cannot find the file/i],
    ["pasted-content-placeholder", /\[Pasted (?:text|content)/i],
    ["enter-to-send", /enter to (?:send|submit)/i],
    ["queued-message", /queued messages?|tab to queue/i],
    ["needs-user-action", /would you like to run the following command|approve this command|approve (?:once|for this session)|permission required|approval required|do you (?:want to )?allow/i],
    ["model-metadata-fallback", /model metadata.{0,80}not found|defaulting to fallback metadata/i],
    ["model-refusal-or-unavailable", /unable to (?:read|access)|cannot (?:read|access)|\bmodel(?! metadata).{0,40}(?:not found|not supported|unavailable)/i],
  ].filter(([, expression]) => expression.test(plain)).map(([fixed]) => fixed);
}

export function recordTaskSignals(diagnostic, screen, elapsedMs) {
  const at = Math.max(0, Math.min(3_600_000, Math.floor(elapsedMs)));
  if (!Number.isFinite(at)) return;
  diagnostic.taskSignals ||= {};
  for (const [kind, values] of [
    ["classifications", classifyProviderOutput(screen)],
    ["fixedErrorExcerpts", taskFailureSignals(screen)],
    ["progressSignals", codexProgressSignals(screen)],
  ]) {
    const entries = diagnostic.taskSignals[kind] ||= {};
    for (const value of values) {
      const previous = entries[value];
      entries[value] = { firstSeenMs: previous?.firstSeenMs ?? at, lastSeenMs: at };
    }
  }
}

export function taskSignalSnapshot(diagnostic) {
  return Object.fromEntries(["classifications", "fixedErrorExcerpts", "progressSignals"].map((kind) =>
    [kind, Object.entries(diagnostic.taskSignals?.[kind] || {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([signal, times]) => ({ signal, ...times }))]));
}

export function composerHints(screen, cursorLine, prompt) {
  // Diagnostic hints, not a focus/readiness proof. The prompt can occur in
  // transcript history as well as a draft. No captured text leaves this helper.
  return {
    source: "heuristic-rendered-terminal-hints",
    authorizesInput: false,
    cursorOnPromptLikeLine: /^\s*[›❯>]\s/.test(cursorLine),
    cursorOnEmptyPromptLikeLine: /^\s*[›❯>]\s*$/.test(cursorLine),
    emptyComposerPlaceholderVisible: /[›❯>]\s*Ask Codex to do anything\b/.test(screen),
    expectedPromptVisibleSomewhere: Boolean(prompt) && screen.replace(/\s/g, "").includes(prompt.replace(/\s/g, "")),
    blockingPromptHintVisible: codexProgressSignals(screen).includes("needs-user-action")
      || classifyProviderOutput(screen).some((kind) => ["workspace-trust-required", "authentication-required", "startup-confirmation-required"].includes(kind)),
  };
}

export async function settleDiagnosticParsers(responders, timeoutMs = 1000) {
  let timer;
  try {
    return await Promise.race([
      Promise.allSettled(responders.map((responder) => responder.chain))
        .then((results) => results.every((result) => result.status === "fulfilled")),
      new Promise((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(false), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

export function recordLifecycle(diagnostic, state, source) {
  if (!["working", "needsAttention", "idle", "done"].includes(state)
    || !["integration", "heuristic"].includes(source)) return;
  const entry = { state, source, phase: diagnostic.phase || "startup" };
  diagnostic.lifecycle = { state, source };
  diagnostic.lifecycleSequence ||= [];
  const last = diagnostic.lifecycleSequence.at(-1);
  if (last?.state === state && last.source === source && last.phase === entry.phase) return;
  if (diagnostic.lifecycleSequence.length < 256) diagnostic.lifecycleSequence.push(entry);
  else diagnostic.lifecycleSequenceTruncated = true;
}

export function nativeInputProbeScript(text) {
  // No CLI/model is involved. Mirror crossterm's Windows raw input mode:
  // clear ENABLE_PROCESSED_INPUT, ENABLE_LINE_INPUT and ENABLE_ECHO_INPUT.
  // Read only this new ConPTY's input records and emit metadata, never text.
  const expected = Buffer.from(text).toString("base64");
  return `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public class InputProbe {
  [StructLayout(LayoutKind.Explicit, Size=20)] public struct Record {
    [FieldOffset(0)] public ushort Kind;
    [FieldOffset(4)] public int Down;
    [FieldOffset(8)] public ushort Repeat;
    [FieldOffset(14)] public ushort Character;
  }
  public class Result {
    public int keyDownEvents, otherEvents, characters, escapeCharacters, enterCount;
    public bool inputMatchesExpected, virtualTerminalInput;
    public long enterAfterLastCharacterMs;
  }
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll")] static extern bool GetConsoleMode(IntPtr handle, out uint mode);
  [DllImport("kernel32.dll")] static extern bool SetConsoleMode(IntPtr handle, uint mode);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool ReadConsoleInputW(IntPtr handle, [Out] Record[] records, uint length, out uint count);
  public static Result Run(string expected) {
    IntPtr handle=GetStdHandle(-10); uint original;
    if (!GetConsoleMode(handle, out original) || !SetConsoleMode(handle, original & ~7u)) throw new Exception("input-mode-unavailable");
    var result=new Result(); result.virtualTerminalInput=(original & 512u)!=0;
    var actual=new StringBuilder(); var clock=Stopwatch.StartNew(); long last=-1;
    Console.Write("\\u001b[?2004hINPUT_PROBE_READY\\r\\n"); Console.Out.Flush();
    try {
      while(clock.ElapsedMilliseconds<10000 && result.enterCount==0) {
        if (WaitForSingleObject(handle,100)!=0) continue;
        var records=new Record[128]; uint count;
        if (!ReadConsoleInputW(handle,records,128,out count)) throw new Exception("input-read-failed");
        for(int i=0;i<count;i++) {
          var entry=records[i];
          if(entry.Kind!=1) {result.otherEvents++; continue;}
          if(entry.Down==0) continue;
          result.keyDownEvents++;
          if(entry.Character==13) {result.enterCount++; result.enterAfterLastCharacterMs=last<0 ? -1 : clock.ElapsedMilliseconds-last;}
          else if(entry.Character!=0) {
            for(int n=0;n<Math.Max(1,(int)entry.Repeat);n++) actual.Append((char)entry.Character);
            last=clock.ElapsedMilliseconds;
            if(entry.Character==27) result.escapeCharacters++;
          }
        }
      }
      result.characters=actual.Length; result.inputMatchesExpected=actual.ToString()==expected;
      return result;
    } finally {SetConsoleMode(handle,original); Console.Write("\\u001b[?2004l");}
  }
}
'@
$taskExpected = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${expected}'))
$taskResult = [InputProbe]::Run($taskExpected) | ConvertTo-Json -Compress
[Console]::WriteLine('INPUT_PROBE_RESULT ' + $taskResult)
`;
}

function safeError(error) {
  return {
    code: /^[a-z]+(?:-[a-z]+)+$/.test(error.message) ? error.message : "verification-failed",
    errorClass: ["Error", "TypeError", "ReferenceError", "SyntaxError", "AssertionError"].includes(error.name) ? error.name : "UnknownError",
    scriptLine: Number(error.stack?.match(/verify-mcp-live-agents\.mjs:(\d+):\d+/)?.[1]) || null,
    nodeCode: ["ENOENT", "EACCES", "EPIPE", "ECONNRESET", "ECONNREFUSED", "EBUSY"].includes(error.code) ? error.code : null,
  };
}

export class TerminalQueryResponder {
  counts = {};
  responses = [];
  chain = Promise.resolve();
  terminal = new Terminal({ cols: 180, rows: 40, scrollback: 80, allowProposedApi: true });

  constructor() {
    // Use the exact parser shipped in the UI, without open(), DOM, or a window.
    // Only standard terminal reports cross back to the owned provider's stdin.
    this.terminal.onData((data) => {
      const kind = [
        ["cursor-position", /^\x1b\[\??\d+;\d+R$/],
        ["primary-device-attributes", /^\x1b\[\?[\d;]+c$/],
        ["secondary-device-attributes", /^\x1b\[>[\d;]+c$/],
        ["device-status", /^\x1b\[\??\d+n$/],
        ["mode-status", /^\x1b\[\??\d{1,5};[0-4]\$y$/],
      ].find(([, expression]) => expression.test(data))?.[0];
      if (kind) this.reply(kind, data);
    });
    // Color handling normally lives in the browser ThemeService. Supply only
    // the fixed test-terminal colors; never handle clipboard/URL/title queries.
    for (const slot of [10, 11, 12]) {
      this.terminal.parser.registerOscHandler(slot, (data) => {
        if (data === "?") this.reply(`osc-${slot}`, `\x1b]${slot};rgb:${slot === 11 ? "1818/1818/1818" : "dddd/dddd/dddd"}\x1b\\`);
        return true;
      });
    }
  }

  reply(kind, data) {
    this.counts[kind] = (this.counts[kind] || 0) + 1;
    this.responses.push(data);
  }

  feed(text) {
    if (text.length === 0) return this.chain.then(() => []);
    const next = this.chain.then(() => new Promise((done) => {
      this.terminal.write(text, () => { const replies = this.responses; this.responses = []; done(replies); });
    }));
    this.chain = next.then(() => undefined);
    return next;
  }

  screenText() {
    const buffer = this.terminal.buffer.active;
    return Array.from({ length: Math.min(buffer.length, 120) }, (_, offset) =>
      buffer.getLine(Math.max(0, buffer.length - 120) + offset)?.translateToString(true) || "").join("\n");
  }

  composerHints(prompt) {
    const buffer = this.terminal.buffer.active;
    const screen = Array.from({ length: this.terminal.rows }, (_, row) =>
      buffer.getLine(buffer.baseY + row)?.translateToString(true) || "").join("\n");
    const cursorLine = buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) || "";
    return composerHints(screen, cursorLine, prompt);
  }

  dispose() { this.terminal.dispose(); }
}

export const MCP_REVIEW_OUTPUT_OPTIONS = Object.freeze({ maxBytes: 65536, stripControlSequences: false });

export class McpReviewVerifier {
  renderer = new TerminalQueryResponder();
  text = "";
  correctRawEverSeen = false;
  correctRenderedEverSeen = false;
  reportedCheckerFailureCodes = new Set();

  constructor(nonce, expected) { this.nonce = nonce; this.expected = expected; }

  async feed(text) {
    if (typeof text !== "string") fail("review-output-invalid");
    this.text = (this.text + text).slice(-256000);
    // The parser sees ONLY bytes returned by read_agent_output. Generated
    // terminal queries are discarded: this evidence parser never writes stdin.
    await this.renderer.feed(text);
    const screen = this.renderer.screenText();
    const correctRaw = verifiedResult(this.text, this.nonce, this.expected);
    const correctRendered = verifiedResult(screen, this.nonce, this.expected);
    this.correctRawEverSeen ||= correctRaw;
    this.correctRenderedEverSeen ||= correctRendered;
    for (const code of reportedCheckerFailures(`${this.text}\n${screen}`)) {
      if (this.reportedCheckerFailureCodes.size < 8) this.reportedCheckerFailureCodes.add(code);
    }
    return {
      source: "mcp-raw-output-and-renderer", stripControlSequences: false,
      resultMarkerSeen: /LATTICE_RESULT/.test(this.text) || /LATTICE_RESULT/.test(screen),
      correctNonceAndComputedValue: correctRaw || correctRendered,
      correctRawNow: correctRaw, correctRenderedNow: correctRendered,
      correctRawEverSeen: this.correctRawEverSeen, correctRenderedEverSeen: this.correctRenderedEverSeen,
      reportedCheckerFailure: this.reportedCheckerFailureCodes.size > 0,
      reportedCheckerFailures: [...this.reportedCheckerFailureCodes],
      checkerFailureSource: "untrusted-cli-text-not-independent-compiler-execution-proof",
    };
  }

  dispose() { this.renderer.dispose(); }
}

export function windowsPipe(directory) {
  const key = realpathSync.native(directory).replace(/^\\\\\?\\/, "")
    .replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(key)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return `\\\\.\\pipe\\latticeterm-agent-${hash.toString(16).padStart(16, "0")}`;
}

class Peer extends EventEmitter {
  constructor(reader, writer, mode) {
    super();
    this.reader = reader; this.writer = writer; this.mode = mode;
    this.next = 1; this.pending = new Map(); this.buffer = ""; this.closed = false;
    reader.setEncoding("utf8");
    reader.on("data", (part) => {
      this.buffer += part;
      for (let end; (end = this.buffer.indexOf("\n")) >= 0;) {
        if (end > MAX_LINE) return this.close();
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { this.close(); return; }
        if (this.mode === "daemon" && message.kind === "event") {
          this.emit("event", message); continue;
        }
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if ((this.mode === "daemon" && !message.ok) || message.error) pending.reject(Error("peer-request-rejected"));
        else pending.resolve(message.result);
      }
      if (this.buffer.length > MAX_LINE) this.close();
    });
    const closed = () => {
      this.closed = true;
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(Error("peer-closed")); }
      this.pending.clear();
    };
    reader.on("end", closed); reader.on("error", closed);
    if (writer !== reader) writer.on("error", closed);
  }
  request(body, params, timeout = 15000) {
    if (this.closed) return Promise.reject(Error("peer-closed"));
    const id = this.next++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error("peer-timeout")); }, timeout);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.writer.write(JSON.stringify(this.mode === "daemon" ? { kind: "request", id, body }
        : { jsonrpc: "2.0", id, method: body, params }) + "\n");
    });
  }
  async call(name, args = {}) {
    const result = await this.request("tools/call", { name, arguments: args }, 20000);
    if (!result || result.isError !== false || !result.structuredContent) fail("mcp-tool-rejected");
    return result.structuredContent;
  }
  close() {
    this.closed = true;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(Error("peer-closed")); }
    this.pending.clear(); this.writer.end(); this.reader.destroy?.();
  }
}

async function waitUntil(predicate, code, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let nextProgress = Date.now() + 20000;
  do {
    const value = await predicate(); if (value) return value;
    if (Date.now() >= nextProgress) { console.log(`Waiting: ${code}`); nextProgress = Date.now() + 20000; }
    await delay(100);
  } while (Date.now() < deadline);
  fail(code);
}

function safeExecutable(path, expectedName) {
  const target = realpathSync.native(path);
  const stat = lstatSync(target);
  if (!stat.isFile() || !target.toLowerCase().endsWith(".exe")) fail("native-executable-required");
  if (expectedName && basename(target).toLowerCase() !== `${expectedName}.exe`) fail("unexpected-cli-name");
  return target;
}

async function main(args) {
  let options;
  try { options = parseOptions(args); } catch { console.error(USAGE); return 2; }
  if (process.platform !== "win32") { console.error("This acceptance harness currently requires Windows native executables."); return 2; }
  const report = {
    schemaVersion: 1, mode: options.mode, startedAt: new Date().toISOString(),
    platform: `Windows ${release()} ${arch()}`, driver: "Node MCP orchestrator with real AI CLI workers",
    syntheticLifecycleReports: false, checks: [], passed: false,
    boundaries: ["Not a desktop UI or installed-application test", "Does not test one AI acting as the MCP client", "Only small read-only TypeScript and Rust review fixtures; not whole-project typecheck or cargo acceptance", "No per-turn interrupt claim", "Codex notify officially reports completion, not working; working is recorded with its actual heuristic source", "Existing provider credentials and native provider session history remain provider-managed", "Provider startup configuration, including existing Codex notification hooks, can still run; this harness is not an account or host security sandbox"],
  };
  const workers = liveWorkers(options);
  const workerFixtures = new Map();
  report.client = { name: "live-agent-acceptance", version: "1.0", nodeVersion: process.version };
  report.fixtureTrustOptIn = Boolean(options.trustOwnedFixture);
  report.workers = ["runtime-preflight", "input-preflight"].includes(options.mode) ? [] : workers.map((worker) => worker.id);
  report.workerProviders = Object.fromEntries(workers.filter((worker) => report.workers.includes(worker.id)).map((worker) => [worker.id, worker.provider]));
  if (options.codexOnly) report.boundaries.push("Codex-only diagnosis, not two-worker acceptance; no Claude process launched");
  if (options.codexPair) {
    report.agentCompilerExecution = "requested-not-independently-attested";
    report.boundaries.push("Two isolated Codex sessions using the existing provider-managed login: frontend/Rust source reviews plus independently executed compiler checks, not proof that an AI tool executed a compiler. No Claude process launched.");
    report.boundaries.push("Both Codex invocations request read-only sandboxing, no approval, web search disabled, and separate fresh working directories. TypeScript uses noEmit; Rust metadata is captured from stdout, never executed or written as a workspace artifact.");
    report.boundaries.push("Compiler identities, immutable fixture hashes, real exit statuses, and matching pre/post output hashes corroborate the independent checks; they are not forensic attestation against a malicious process under the same account.");
  }
  if (options.mode === "run-live") {
    report.requiredChecks = requiredLiveChecks(Boolean(options.codexOnly), Boolean(options.codexPair));
    report.boundaries.push("Review answers are verified only from authorized MCP read_agent_output with stripControlSequences:false and its local terminal renderer; this does not validate the default sanitized-output mode. Desktop output is diagnostic only.");
  }
  if (options.trustOwnedFixture) report.boundaries.push("Claude CLI may persist trust for the exact new fixture project; this harness never edits, copies, or removes provider configuration or credentials. Other prompts are not approved.");
  const inputPreflight = options.mode === "input-preflight";
  const runtimePreflight = options.mode === "runtime-preflight" || inputPreflight;
  if (runtimePreflight) {
    report.driver = "Node orchestrator with Windows system runtimes in real ConPTY sessions";
    report.boundaries = ["No AI providers or accounts used", "Not a desktop UI or installed-application test", "No MCP AI-dispatch or provider readiness claim"];
  }
  const children = new Set(), peers = new Set(), sessionIds = new Set(), ownedSessionIds = new Set();
  const providerIds = new Map(), diagnostics = new Map(), terminalResponders = new Map();
  let root, work, data, desktop, daemon, adapter, stage = "preflight";
  let launchAttempts = 0;
  let signalReceived = false;
  const onSignal = () => { signalReceived = true; };
  process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal);
  const spawnOwned = (exe, argv, extra = {}) => {
    if (signalReceived) fail("operator-cancelled");
    const child = spawn(exe, argv, { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], ...extra });
    children.add(child); child.once("exit", () => children.delete(child));
    child.on("error", () => {}); child.stderr.on("data", () => {});
    return child;
  };
  const readOnlyCommand = async (exe, args, maximum = 256000) => {
    const child = spawnOwned(exe, args);
    let output = "";
    let oversized = false;
    child.stdout.on("data", (data) => {
      output += data.toString();
      if (output.length > maximum) { output = ""; oversized = true; child.kill(); }
    });
    const code = await new Promise((done) => {
      const timer = setTimeout(() => { child.kill(); done(-1); }, 15000);
      child.once("exit", (code) => { clearTimeout(timer); done(code); });
      child.once("error", () => { clearTimeout(timer); done(-1); });
    });
    if (code !== 0 || oversized) fail("provider-readonly-command-failed");
    return output;
  };
  const runVersion = async (exe) => {
    const output = await readOnlyCommand(exe, ["--version"], 4096);
    const version = output.match(/\b\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.]+)?\b/)?.[0];
    if (!version) fail("provider-version-unrecognized");
    return { version, executableName: basename(exe), executableSha256: sha(readFileSync(exe)) };
  };
  const runCompiler = async (worker) => {
    const source = join(worker.directory, worker.sourceName);
    if (sha(readFileSync(worker.compiler)) !== worker.compilerIdentity.executableSha256
      || sha(readFileSync(source)) !== worker.sourceHash) fail("compiler-identity-or-source-changed");
    const child = spawnOwned(worker.compiler, pairCompilerArguments(worker.kind), { cwd: worker.directory });
    const stdoutHash = createHash("sha256"), stderrHash = createHash("sha256");
    let stdoutBytes = 0, stderrBytes = 0, interrupted = false;
    child.stdout.on("data", (bytes) => {
      stdoutBytes += bytes.length; stdoutHash.update(bytes);
      if (stdoutBytes + stderrBytes > 1024 * 1024) { interrupted = true; child.kill(); }
    });
    child.stderr.on("data", (bytes) => {
      stderrBytes += bytes.length; stderrHash.update(bytes);
      if (stdoutBytes + stderrBytes > 1024 * 1024) { interrupted = true; child.kill(); }
    });
    const exitCode = await new Promise((done) => {
      const timer = setTimeout(() => { interrupted = true; child.kill(); }, 30000);
      child.once("error", () => { interrupted = true; });
      child.once("close", (code) => { clearTimeout(timer); done(code); });
    });
    if (sha(readFileSync(worker.compiler)) !== worker.compilerIdentity.executableSha256
      || sha(readFileSync(source)) !== worker.sourceHash) fail("compiler-identity-or-source-changed");
    return { exitCode, interrupted, compilerSha256: worker.compilerIdentity.executableSha256,
      sourceSha256: worker.sourceHash, stdoutBytes, stdoutSha256: stdoutHash.digest("hex"),
      stderrBytes, stderrSha256: stderrHash.digest("hex"), compiledCodeExecuted: false,
      evidenceSource: "harness-spawned-native-compiler", outputDestination: "bounded-pipes" };
  };
  try {
    const lattice = safeExecutable(options.lattice);
    const claude = runtimePreflight || options.codexOnly || options.codexPair ? null : safeExecutable(options.claude, "claude");
    const codex = runtimePreflight ? null : safeExecutable(options.codex, "codex");
    report.latticeExecutableSha256 = sha(readFileSync(lattice));
    let codexMcpArgs = [];
    if (!runtimePreflight) {
      report.providers = { ...(claude ? { claude: await runVersion(claude) } : {}), codex: await runVersion(codex) };
      report.checks.push({ id: "native-provider-inventory", status: "passed", paidRequests: 0 });
      // Empty tables merge with existing Codex configuration and DO NOT clear
      // MCP servers. Read only the inventory, disable each current server in
      // this invocation, then verify the effective inventory without logging it.
      const configuredServers = JSON.parse(await readOnlyCommand(codex, ["mcp", "list", "--json"]));
      codexMcpArgs = disabledMcpArguments(configuredServers);
      const disabledServers = JSON.parse(await readOnlyCommand(codex, [...codexMcpArgs, "mcp", "list", "--json"]));
      if (!Array.isArray(disabledServers) || disabledServers.some((server) => server.enabled !== false)) fail("codex-mcp-disable-unconfirmed");
      report.checks.push({ id: "codex-configured-mcp-disabled-for-test-invocation", status: "passed", configuredCount: configuredServers.length,
        enabledAfterOverride: 0, userConfigurationChanged: false });
    }
    if (options.mode === "preflight") { report.passed = true; return report; }
    const ptyPreflight = options.mode === "pty-preflight" || runtimePreflight;
    console.log(ptyPreflight
      ? inputPreflight ? "Native input preflight: owned PowerShell ConPTY input probes only; no AI CLI, account, or model prompts."
        : runtimePreflight ? "Runtime preflight: Windows cmd, PowerShell, and Node marker probes only; no AI CLI, account, or model prompts."
          : "PTY preflight: provider --help/--version and system runtime probes in owned test sessions; no model prompts."
      : `Live acceptance opted in: ${options.codexPair ? "two isolated Codex workers; two bootstraps and frontend/Rust source reviews with independent native compiler checks" : options.codexOnly ? "one Codex session; bootstrap plus one read-only review" : "two new CLI sessions; Codex bootstrap plus two read-only reviews"}. Owned fixture trust: ${options.trustOwnedFixture ? "one narrowly verified Claude confirmation allowed" : "not approved"}. No login or unrelated permission prompts will be answered.`);
    root = mkdtempSync(join(tmpdir(), "lattice-mcp-live-"));
    // Use a canonical long path before hashing the Windows pipe name.
    root = realpathSync.native(root).replace(/^\\\\\?\\/, "");
    data = join(root, "data"); work = join(root, "work"); mkdirSync(data); mkdirSync(work);
    // Trust only this freshly created, known fixture through invocation-local
    // configuration. Do not change the provider's persistent trust or login.
    if (!ptyPreflight && !options.codexPair) codexMcpArgs.push(...fixtureTrustArguments(work));
    const fixture = makeFixtures();
    if (!options.codexPair) for (const [name, content] of Object.entries(fixture.files)) writeFileSync(join(work, name), content, { flag: "wx" });
    const before = options.codexPair ? null : fixtureSnapshot(work);
    if (options.codexPair) {
      stage = "native-compiler-inventory";
      const require = createRequire(import.meta.url);
      const tsc = safeExecutable(options.tsc || join(dirname(require.resolve(`@typescript/typescript-${process.platform}-${process.arch}/package.json`)), "lib", "tsc.exe"), "tsc");
      const rustc = safeExecutable(options.rustc, "rustc");
      // Require an already-installed native toolchain layout, not the rustup
      // proxy in .cargo/bin; no command here can install/update a toolchain.
      if (!existsSync(join(dirname(dirname(rustc)), "lib", "rustlib"))
        || !readdirSync(dirname(rustc)).some((name) => /^rustc_driver[^/\\]*\.dll$/i.test(name))) fail("installed-native-rustc-required");
      report.compilers = { frontend: await runVersion(tsc), rust: await runVersion(rustc) };
      report.checks.push({ id: stage, status: "passed", identities: report.compilers, installedNativeCompilersOnly: true });
      report.fixtureHashes = {};
      for (const spec of workers) {
        const directory = join(work, spec.id); mkdirSync(directory);
        const sourceFixture = makeFixtures();
        const sourceName = spec.kind === "frontend" ? "review.ts" : "review.rs";
        const sourceText = sourceFixture.files[sourceName], sourceHash = sha(sourceText);
        const compiler = spec.kind === "frontend" ? tsc : rustc;
        const compilerIdentity = report.compilers[spec.id];
        writeFileSync(join(directory, sourceName), sourceText, { flag: "wx" });
        if (spec.kind === "frontend") writeFileSync(join(directory, "tsconfig.json"), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, target: "ES2020", module: "ESNext", types: [], skipLibCheck: true },
          files: ["review.ts"],
        }), { flag: "wx" });
        writeFileSync(join(directory, "checker.mjs"), pairCheckerScript(compiler, compilerIdentity, spec.kind, sourceHash), { flag: "wx" });
        const worker = { ...spec, directory, sourceName, sourceHash, compiler, compilerIdentity,
          nonce: sourceFixture.nonce, score: sourceFixture.scores[spec.kind === "frontend" ? "claude" : "codex"],
          before: fixtureSnapshot(directory) };
        workerFixtures.set(spec.id, worker);
        report.fixtureHashes[spec.id] = Object.fromEntries(worker.before);
        stage = `${spec.id}-compiler-preflight`;
        worker.compilerPreflight = await runCompiler(worker);
        assert.deepEqual(fixtureSnapshot(directory), worker.before);
        const passed = compilerResultMatches(worker.compilerPreflight, worker.compilerPreflight, spec.kind);
        report.checks.push({ id: stage, status: passed ? "passed" : "failed", ...worker.compilerPreflight, paidRequests: 0 });
        if (!passed) fail("compiler-preflight-failed");
      }
    } else {
      report.fixtureHashes = Object.fromEntries(before);
      for (const spec of workers) workerFixtures.set(spec.id, { ...spec, directory: work,
        nonce: fixture.nonce, score: fixture.scores[spec.provider] });
    }
    const env = { ...process.env };
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
    if (!runtimePreflight) env[pathKey] = `${[claude, codex].filter(Boolean).map(dirname).join(";")};${env[pathKey] || ""}`;
    stage = "isolated-daemon";
    daemon = spawnOwned(lattice, ["agent-daemon", "--data-dir", data], { env });
    stage = "isolated-daemon-connect";
    const socket = await waitUntil(() => new Promise((done) => {
      const socket = createConnection(windowsPipe(data));
      socket.once("connect", () => done(socket));
      socket.once("error", () => { socket.destroy(); done(null); });
    }), "isolated-daemon-unavailable");
    desktop = new Peer(socket, socket, "daemon"); peers.add(desktop);
    stage = "isolated-daemon-authenticate";
    const hello = await desktop.request({ type: "hello", protocol: 1, role: "desktop",
      token: readFileSync(join(data, "agent-daemon.token"), "utf8").trim() });
    if (hello.mcpProtocol !== 2) fail("mcp-protocol-unavailable");
    if (options.mode === "run-live" && hello.mcpOutputScopes !== true) fail("mcp-output-scopes-unavailable");
    desktop.on("event", (event) => {
      const id = event.payload.sessionId;
      if (typeof id !== "string") return;
      const diagnostic = diagnostics.get(id) || { bytes: 0, tail: "", classes: new Set(), closed: false };
      diagnostics.set(id, diagnostic);
      if (event.name === "state") recordLifecycle(diagnostic, event.payload.state, event.payload.source);
      if (event.name === "launched") {
        ownedSessionIds.add(id);
        if (Number.isInteger(event.payload.processId)) diagnostic.processId = event.payload.processId;
      }
      if (event.name === "closed") {
        sessionIds.delete(id); diagnostic.closed = true;
        const reason = String(event.payload.reason || "");
        const code = reason.match(/code:\s*(-?\d+)/)?.[1];
        if (code) {
          diagnostic.exitCode = Number(code);
          const classification = nativeExitClassification(code);
          if (classification) diagnostic.classes.add(classification);
        }
        for (const code of classifyProviderOutput(reason)) diagnostic.classes.add(code);
      }
      if (event.name === "data") {
        const bytes = Buffer.from(event.payload.base64, "base64");
        diagnostic.bytes += bytes.length;
        diagnostic.tail = (diagnostic.tail + bytes.toString()).slice(-65536);
        for (const code of classifyProviderOutput(diagnostic.tail)) diagnostic.classes.add(code);
        const responder = terminalResponders.get(id) || new TerminalQueryResponder();
        terminalResponders.set(id, responder);
        diagnostic.terminalQueries = responder.counts;
        // Terminal replies only; never Enter, trust approval, auth, or hook injection.
        void responder.feed(bytes).then(async (replies) => {
          diagnostic.screen = responder.screenText();
          for (const code of classifyProviderOutput(diagnostic.screen)) diagnostic.classes.add(code);
          for (const reply of replies) await desktop.request({ type: "send", sessionId: event.payload.sessionId,
            data: Buffer.from(reply).toString("base64") }).catch(() => {});
        }).catch(() => { diagnostic.classes.add("terminal-parser-error"); });
        // A separate renderer begins at the MCP-task baseline. Startup banners
        // and their /login hints cannot contaminate task-failure diagnostics.
        if (diagnostic.taskResponder) {
          void diagnostic.taskResponder.feed(bytes).then(() => {
            diagnostic.taskScreen = diagnostic.taskResponder.screenText();
            recordTaskSignals(diagnostic, diagnostic.taskScreen, performance.now() - diagnostic.taskStartedAt);
          }).catch(() => { diagnostic.classes.add("terminal-parser-error"); });
        }
      }
    });
    stage = "isolated-mcp-adapter";
    const mcp = spawnOwned(lattice, ["mcp", "--data-dir", data], { env });
    adapter = new Peer(mcp.stdout, mcp.stdin, "mcp"); peers.add(adapter);
    stage = "isolated-mcp-initialize";
    await adapter.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "live-agent-acceptance", version: "1.0" } });
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const launched = {};
    const shortPathProbes = [];
    if (ptyPreflight && !runtimePreflight) {
      const systemRoot = process.env.SystemRoot || "C:\\Windows";
      const probePath = [join(systemRoot, "System32"), systemRoot, dirname(claude), dirname(codex), dirname(process.execPath)].join(";");
      for (const [name, executable, argument] of [
        ["powershell", join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoProfile -NonInteractive -Command Write-Output PTY_RUNTIME_OK"],
        ["node", process.execPath, "--version"], ["claude", claude, "--version"], ["codex", codex, "--version"],
      ]) {
        if (/[\r\n%!\"]/.test(executable + probePath)) fail("short-path-probe-unsafe-path");
        const batch = join(root, `short-path-${name}.cmd`);
        writeFileSync(batch, `@echo off\r\nsetlocal\r\nset "PATH=${probePath}"\r\n"${executable}" ${argument}\r\nexit /b %errorlevel%\r\n`, { flag: "wx" });
        shortPathProbes.push({ name: `${name}-child-only-short-path`, provider: "system", definitionId: "custom",
          executable: join(systemRoot, "System32", "cmd.exe"), args: ["/d", "/c", batch] });
      }
    }
    const runtimeCases = [
      { name: "system-cmd-marker", provider: "system", definitionId: "custom", executable: join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"), args: ["/d", "/c", "echo", "PTY_RUNTIME_OK"], expectedOutput: /PTY_RUNTIME_OK/ },
      { name: "system-powershell-marker", provider: "system", definitionId: "custom", executable: join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), args: ["-NoProfile", "-NonInteractive", "-Command", "Write-Output PTY_RUNTIME_OK"], expectedOutput: /PTY_RUNTIME_OK/ },
      { name: "node-runtime-marker", provider: "system", definitionId: "custom", executable: process.execPath, args: ["-e", "process.stdout.write('PTY_RUNTIME_OK')"], expectedOutput: /PTY_RUNTIME_OK/ },
    ];
    const inputCases = inputPreflight ? ["short", "review"].flatMap((kind) => [false, true].map((split) => {
      const text = kind === "short" ? "INPUT_PROBE" : reviewPrompt("codex");
      const path = join(root, `input-${kind}-${split ? "split" : "single"}.ps1`);
      writeFileSync(path, nativeInputProbeScript(text), { flag: "wx" });
      return { name: `native-input-${kind}-${split ? "split" : "single"}`, provider: "system", definitionId: "custom",
        executable: join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        args: ["-NoProfile", "-NonInteractive", "-File", path], inputProbe: { text, split } };
    })) : [];
    const cases = inputPreflight ? inputCases : runtimePreflight ? runtimeCases : ptyPreflight ? [
      ...runtimeCases,
      { name: "claude-native-version", provider: "claude", definitionId: "custom", args: ["--version"] },
      { name: "claude-native-help", provider: "claude", definitionId: "custom", args: ["--help"] },
      { name: "claude-integrated-help", provider: "claude", definitionId: "claude", args: ["--help"] },
      { name: "claude-restricted-help", provider: "claude", definitionId: "claude", restrictedHelp: true },
      { name: "codex-native-version", provider: "codex", definitionId: "custom", args: ["--version"] },
      { name: "codex-native-help", provider: "codex", definitionId: "custom", args: ["--help"] },
      { name: "codex-integrated-help", provider: "codex", definitionId: "codex", args: ["--help"] },
      ...shortPathProbes,
    ] : workers.map((worker) => ({ name: worker.id, provider: worker.provider, definitionId: worker.provider }));
    for (const entry of cases) {
      const { name, provider, definitionId } = entry;
      const directory = workerFixtures.get(name)?.directory || work;
      stage = `${name}-launch`;
      const argumentsForCli = provider === "claude"
        ? ["--setting-sources", "", "--tools", "Read", "--allowedTools", "Read(./review.ts)", "--disable-slash-commands", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']
        : options.codexPair ? pairCodexArguments(directory, codexMcpArgs)
          : ["--sandbox", "read-only", "--ask-for-approval", "never", "--no-alt-screen", ...codexMcpArgs, BOOTSTRAP];
      launchAttempts++;
      const session = await desktop.request({ type: "launch", request: { definitionId,
        executable: entry.executable || (provider === "claude" ? claude : codex),
        label: `${name} acceptance`, arguments: entry.args || (entry.restrictedHelp ? ["--help", ...argumentsForCli] : argumentsForCli), workingDirectory: directory,
        cols: 180, rows: 40, detached: true, sandbox: false } }, undefined,
      // Windows Codex now performs a bounded metadata-only profile preflight.
      // This changes only launch RPC waiting, not the model-turn deadline.
      definitionId === "codex" ? 30000 : 15000);
      sessionIds.add(session.sessionId);
      ownedSessionIds.add(session.sessionId);
      const launchedDiagnostic = diagnostics.get(session.sessionId) || { bytes: 0, tail: "", classes: new Set(), closed: false };
      if (Number.isInteger(session.processId)) launchedDiagnostic.processId = session.processId;
      diagnostics.set(session.sessionId, launchedDiagnostic);
      providerIds.set(name, session.sessionId);
      const expected = realpathSync.native(entry.executable || (provider === "claude" ? claude : codex));
      if (realpathSync.native(session.executable).toLowerCase() !== expected.toLowerCase()) fail("provider-source-mismatch");
      if (realpathSync.native(session.workingDirectory).toLowerCase() !== realpathSync.native(directory).toLowerCase()) fail("fixture-working-directory-mismatch");
      launched[name] = session.sessionId;
      if (ptyPreflight) {
        if (entry.inputProbe) {
          stage = `${name}-native-input`;
          await waitUntil(() => diagnostics.get(session.sessionId)?.tail.includes("INPUT_PROBE_READY"), "native-input-probe-not-ready", 20000);
          const { text, split } = entry.inputProbe;
          const paste = `\x1b[200~${text}\x1b[201~`;
          await desktop.request({ type: "send", sessionId: session.sessionId, data: Buffer.from(paste + (split ? "" : "\r")).toString("base64") });
          if (split) {
            await delay(250);
            await desktop.request({ type: "send", sessionId: session.sessionId, data: Buffer.from("\r").toString("base64") });
          }
        }
        stage = `${name}-exit`;
        await waitUntil(() => diagnostics.get(session.sessionId)?.closed, "pty-help-did-not-exit", 20000);
        const diagnostic = diagnostics.get(session.sessionId);
        if (entry.inputProbe) {
          const rawResult = stripVTControlCharacters(diagnostic.tail).match(/INPUT_PROBE_RESULT (\{[^\r\n]+\})/)?.[1];
          if (!rawResult) fail("native-input-probe-result-missing");
          const nativeInput = JSON.parse(rawResult);
          report.checks.push({ id: name, status: diagnostic.exitCode === 0 && nativeInput.inputMatchesExpected && nativeInput.enterCount === 1 ? "passed" : "failed",
            exitCode: diagnostic.exitCode, textCharacters: entry.inputProbe.text.length, pasteAndEnterSeparateWrites: entry.inputProbe.split,
            configuredDelayMs: entry.inputProbe.split ? 250 : 0, nativeInput, paidRequests: 0 });
          continue;
        }
        const outputVerified = entry.expectedOutput ? entry.expectedOutput.test(diagnostic.tail) : diagnostic.bytes > 0;
        report.checks.push({ id: name, status: diagnostic.exitCode === 0 && outputVerified ? "passed" : "failed", exitCode: diagnostic.exitCode ?? null, expectedOutputVerified: outputVerified,
          terminalBytesSeen: diagnostic.bytes, paidRequests: 0 });
        continue;
      }
      const shared = await desktop.request({ type: "shareSet", sessionId: session.sessionId, shared: true, readOutput: true });
      if (shared.find((entry) => entry.sessionId === session.sessionId)?.readOutput !== true) fail("explicit-content-grant-unconfirmed");
      const controlled = await desktop.request({ type: "controlSet", sessionId: session.sessionId, control: true });
      const grant = controlled.find((entry) => entry.sessionId === session.sessionId);
      if (grant?.control !== true || grant?.readOutput !== true) fail("explicit-control-grant-unconfirmed");
    }
    if (ptyPreflight) { report.passed = report.checks.every((check) => check.status === "passed"); return report; }
    if (new Set(Object.values(launched)).size !== workers.length) fail("worker-sessions-not-distinct");
    if (options.codexPair && new Set([...workerFixtures.values()].map((worker) => worker.directory.toLowerCase())).size !== 2) fail("worker-directories-not-distinct");
    report.checks.push({ id: options.codexOnly ? "one-isolated-real-codex-session" : "two-isolated-real-cli-sessions", status: "passed",
      workers: report.workers, providers: report.workerProviders, explicitContentAndControlGrants: true,
      ...(options.codexPair ? { distinctWorkingDirectories: true, sameProviderDifferentSessions: true } : {}) });
    let claudeFixtureTrusted = false;
    const currentSession = async (id) => {
      if (signalReceived) fail("operator-cancelled");
      if (!sessionIds.has(id)) fail("provider-session-closed");
      const result = await adapter.call("list_agent_sessions");
      for (const session of result.sessions) {
        const diagnostic = diagnostics.get(session.sessionId);
        if (diagnostic) recordLifecycle(diagnostic, session.state, session.stateSource);
      }
      const session = result.sessions.find((item) => item.sessionId === id);
      if (!session) fail("shared-session-missing");
      if (options.trustOwnedFixture && id === launched.claude && !claudeFixtureTrusted
        && ownedFixtureTrustReady(diagnostics.get(id)?.screen || "", work)) {
        if (sha(readFileSync(claude)) !== report.providers.claude.executableSha256) fail("provider-source-changed");
        if (realpathSync.native(session.workingDirectory).toLowerCase() !== realpathSync.native(work).toLowerCase()) fail("fixture-working-directory-mismatch");
        assert.deepEqual(fixtureSnapshot(work), before);
        claudeFixtureTrusted = true;
        await desktop.request({ type: "send", sessionId: id, data: Buffer.from("\r").toString("base64") });
        report.checks.push({ id: "claude-owned-fixture-trust-confirmed", status: "passed", exactCanonicalDirectory: true,
          providerHashUnchanged: true, confirmations: 1, providerMayPersistProjectTrust: true });
      }
      if (session.state === "needsAttention") {
        // A StopFailure hook can precede its rendered error. Let the owned
        // terminal consume that bounded output, without answering the prompt.
        await delay(300);
        fail("provider-needs-human-attention");
      }
      return session;
    };
    for (const [provider, id] of Object.entries(launched)) {
      stage = `${provider}-official-readiness`;
      const ready = await waitUntil(async () => {
        const session = await currentSession(id);
        return session.stateSource === "integration" && ["idle", "done"].includes(session.state) ? session : null;
      }, `${provider}-official-readiness-missing`, options.timeoutSeconds * 1000);
      report.checks.push({ id: stage, status: "passed", state: ready.state, stateSource: ready.stateSource,
        bootstrap: workerFixtures.get(provider).provider === "codex" ? "actual CLI prompt and official completion notification" : "official SessionStart hook" });
    }
    const baselines = {};
    for (const [provider, id] of Object.entries(launched)) {
      // Exclude all startup text and prompt echoes from previous work.
      baselines[provider] = (await adapter.call("read_agent_output", { sessionId: id })).endOffset;
      const diagnostic = diagnostics.get(id);
      const responder = terminalResponders.get(id);
      const parserSettled = await settleDiagnosticParsers(responder ? [responder] : []);
      diagnostic.expectedPrompt = options.codexPair ? pairPrompt(workerFixtures.get(provider).kind) : reviewPrompt(provider);
      diagnostic.composer = { beforeDispatchParserSettled: parserSettled,
        beforeDispatch: responder?.composerHints(diagnostic.expectedPrompt) || null };
      diagnostic.phase = "review";
      diagnostic.taskStartedAt = performance.now();
      diagnostic.taskResponder = new TerminalQueryResponder();
    }
    stage = options.codexOnly ? "mcp-codex-dispatch" : "mcp-parallel-dispatch";
    await Promise.all(Object.entries(launched).map(async ([provider, id]) => {
      const prompt = { sessionId: id, text: options.codexPair ? pairPrompt(workerFixtures.get(provider).kind) : reviewPrompt(provider),
        mode: "now", requestId: `${provider}-${randomUUID()}` };
      const first = await adapter.call("send_agent_prompt", prompt);
      if (!first.sentImmediately || first.queued !== 0) fail("mcp-prompt-not-delivered");
      const responder = terminalResponders.get(id);
      diagnostics.get(id).composer.afterWriteParserSettled = await settleDiagnosticParsers(responder ? [responder] : []);
      diagnostics.get(id).composer.afterWrite = responder?.composerHints(prompt.text) || null;
      const retry = await adapter.call("send_agent_prompt", prompt);
      if (retry.duplicate !== true) fail("mcp-retry-not-deduplicated");
    }));
    report.checks.push({ id: stage, status: "passed", accepted: report.workers.length, sameRequestIdRetriesDeduplicated: report.workers.length });
    stage = "mcp-worker-reviews";
    const reviews = await Promise.allSettled(Object.entries(launched).map(async ([provider, id]) => {
      let cursor = baselines[provider];
      const worker = workerFixtures.get(provider);
      const verifier = new McpReviewVerifier(worker.nonce, worker.score);
      let totalPagesRead = 0, totalTextBytes = 0;
      try {
        await waitUntil(async () => {
          let page, evidence, pagesRead = 0;
          do {
            if (++pagesRead > 64) fail("review-output-backlog-exceeded");
            page = await adapter.call("read_agent_output", { sessionId: id, cursor, ...MCP_REVIEW_OUTPUT_OPTIONS });
            if (page.truncated) fail("review-output-truncated");
            if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor < cursor
              || (page.hasMore && page.nextCursor <= cursor)) fail("output-cursor-stalled");
            totalPagesRead++;
            totalTextBytes += Buffer.byteLength(page.text);
            cursor = page.nextCursor;
            evidence = await verifier.feed(page.text);
          } while (page.hasMore);
          const diagnostic = diagnostics.get(id);
          diagnostic.reviewEvidence = { outputReadAfterBaseline: cursor > baselines[provider],
            totalPagesRead, totalTextBytes, cursorAdvanceBytes: cursor - baselines[provider], ...evidence };
          const state = await currentSession(id);
          return state.stateSource === "integration" && ["idle", "done"].includes(state.state)
            && diagnostic.reviewEvidence.outputReadAfterBaseline && evidence.correctNonceAndComputedValue;
        }, `${provider}-review-not-confirmed`, options.timeoutSeconds * 1000);
        const workingSources = [...new Set((diagnostics.get(id)?.lifecycleSequence || [])
          .filter((entry) => entry.phase === "review" && entry.state === "working").map((entry) => entry.source))];
        if (worker.provider === "claude" && !workingSources.includes("integration")) fail("claude-official-working-not-observed");
        return { id: `${provider}-verified-review`, status: "passed", correctNonceAndComputedValue: true, officialCompletion: true,
          evidenceSource: "mcp-raw-output-and-renderer", stripControlSequences: false,
          workerId: worker.id, provider: worker.provider, providerStillRunning: sessionIds.has(id), workingStateSources: workingSources,
          reportedCheckerFailures: diagnostics.get(id).reviewEvidence.reportedCheckerFailures,
          ...(options.codexPair ? { task: "model-source-review", agentCompilerExecution: "requested-not-independently-attested" } : {}) };
      } finally { verifier.dispose(); }
    }));
    const reviewsByProvider = Object.fromEntries(Object.keys(launched).map((provider, index) => [provider, reviews[index]]));
    reviews.forEach((result, index) => report.checks.push(result.status === "fulfilled" ? result.value
      : { id: `${Object.keys(launched)[index]}-verified-review`, status: "failed", ...safeError(result.reason) }));
    if (options.codexPair) {
      for (const worker of workerFixtures.values()) {
        stage = `${worker.id}-independent-compiler-check`;
        assert.deepEqual(fixtureSnapshot(worker.directory), worker.before);
        const compilerResult = await runCompiler(worker);
        assert.deepEqual(fixtureSnapshot(worker.directory), worker.before);
        const matches = compilerResultMatches(worker.compilerPreflight, compilerResult, worker.kind);
        report.checks.push({ id: stage, status: matches ? "passed" : "failed", ...compilerResult,
          compilerOutputMatchesPreflight: matches, fixtureFilesUnchanged: true,
          agentCompilerExecution: "requested-not-independently-attested" });
      }
    }
    stage = "read-only-fixture-integrity";
    if (options.codexPair) {
      if (readdirSync(work).sort().join(",") !== "frontend,rust") fail("unexpected-worker-directories");
      for (const worker of workerFixtures.values()) assert.deepEqual(fixtureSnapshot(worker.directory), worker.before);
    } else assert.deepEqual(fixtureSnapshot(work), before);
    report.checks.push({ id: stage, status: "passed", sourceFilesUnchanged: true, newFiles: 0 });
    {
      stage = options.codexOnly ? "mcp-session-cancel" : "mcp-session-cancel-isolation";
      const { target: targetWorker, survivor: survivorWorker } = cancellationWorkers(options);
      const target = launched[targetWorker];
      const diagnostic = diagnostics.get(target);
      const prerequisiteFailure = cancelPrerequisiteFailure(reviewsByProvider, Boolean(options.codexOnly),
        sessionIds.has(target) && diagnostic && !diagnostic.closed, Boolean(options.codexPair));
      if (prerequisiteFailure) {
        report.checks.push({ id: stage, status: "failed", code: prerequisiteFailure });
      } else {
        diagnostic.phase = "ending";
        const ended = await adapter.call("cancel_agent_task", { sessionId: target,
          scope: "session", requestId: `end-review-${randomUUID()}` });
        if (ended.ended !== true) fail("session-cancel-not-accepted");
        await waitUntil(() => diagnostic.closed, "session-cancel-close-event-missing");
        const pid = diagnostic.processId;
        if (!Number.isInteger(pid) || pid <= 0) fail("owned-cli-process-id-missing");
        await waitUntil(() => ownedCliCleanupEvidence([pid]).confirmed, "cancelled-cli-process-still-running");
        const remaining = await adapter.call("list_agent_sessions");
        if (remaining.sessions.some((session) => session.sessionId === target)) fail("cancelled-session-still-shared");
        if (!options.codexOnly) {
          const otherId = launched[survivorWorker];
          const otherPid = diagnostics.get(otherId)?.processId;
          if (!remaining.sessions.some((session) => session.sessionId === otherId)
            || !sessionIds.has(otherId) || diagnostics.get(otherId)?.closed
            || !Number.isInteger(otherPid) || otherPid <= 0) fail("other-cli-was-not-preserved");
          process.kill(otherPid, 0);
        }
        report.checks.push({ id: stage, status: "passed", scope: "session", officialClosedEvent: true,
          ownedProcessExited: true, cleanupNotUsedAsEvidence: true,
          ...(options.codexOnly ? { otherProviderCheck: "not-applicable-single-worker", codexReviewPassed: true }
            : options.codexPair ? { cancelledWorker: targetWorker, survivingWorker: survivorWorker, otherWorkerStillAliveAndShared: true, bothReviewsPassed: true }
              : { otherProviderStillAliveAndShared: true, bothReviewsPassed: true }) });
      }
    }
    stage = options.codexOnly ? "cancellation-revoked-sharing" : "revocation";
    for (const id of Object.values(launched)) if (sessionIds.has(id)) await desktop.request({ type: "shareSet", sessionId: id, shared: false });
    const hidden = await adapter.call("list_agent_sessions");
    if (hidden.sessions.length !== 0) fail("revocation-not-observed");
    report.checks.push({ id: stage, status: "passed", visibleSessions: 0 });
    report.passed = liveChecksPassed(report.checks, Boolean(options.codexOnly), Boolean(options.codexPair));
  } catch (error) {
    report.checks.push({ id: stage, status: "failed", ...safeError(error) });
  } finally {
    // Drain only already-enqueued parser work. Do not wait for new provider
    // output or extend the model deadline to turn missing evidence into a pass.
    report.diagnosticParsersSettled = await settleDiagnosticParsers([
      ...terminalResponders.values(), ...[...diagnostics.values()].map((item) => item.taskResponder).filter(Boolean),
    ]);
    report.providerDiagnostics = Object.fromEntries([...providerIds].map(([provider, id]) => {
      const diagnostic = diagnostics.get(id);
      return [provider, diagnostic ? { terminalBytesSeen: diagnostic.bytes, classifications: [...diagnostic.classes].sort(),
        startupSignals: startupSignals(diagnostic.screen || diagnostic.tail), terminalQueries: diagnostic.terminalQueries || {}, lifecycle: diagnostic.lifecycle || null,
        lifecycleSequence: diagnostic.lifecycleSequence || [], lifecycleSequenceTruncated: Boolean(diagnostic.lifecycleSequenceTruncated),
        taskDiagnostics: diagnostic.taskResponder ? { baseline: "only output after MCP dispatch baseline", classifications: classifyProviderOutput(diagnostic.taskScreen || ""), fixedErrorExcerpts: taskFailureSignals(diagnostic.taskScreen || ""),
          progressSignals: codexProgressSignals(diagnostic.taskScreen || ""),
          finalScreenOnly: true, accumulated: taskSignalSnapshot(diagnostic) } : null,
        composer: diagnostic.composer ? { ...diagnostic.composer,
          final: terminalResponders.get(id)?.composerHints(diagnostic.expectedPrompt) || null } : null,
        reviewEvidence: diagnostic.reviewEvidence || null,
        closedBeforeCleanup: diagnostic.closed, exitCode: diagnostic.exitCode ?? null, rawOutputInReport: false }
        : { terminalBytesSeen: 0, classifications: [], closedBeforeCleanup: false, rawOutputInReport: false }];
    }));
    stage = "cleanup";
    const cliCleanupEvidence = () => ownedCliCleanupEvidence([
      ...[...ownedSessionIds].map((id) => diagnostics.get(id)?.processId),
      // A launch that timed out without its event/reply is not evidence that
      // no process was created. Keep cleanup unconfirmed instead of guessing.
      ...Array(Math.max(0, launchAttempts - ownedSessionIds.size)).fill(undefined),
    ]);
    if (desktop && !desktop.closed && daemon?.exitCode === null) {
      // These IDs came only from this newly created daemon. Do not enumerate
      // the user's CLI processes or kill a process found by name/PID probing.
      await Promise.allSettled([...ownedSessionIds]
        .filter((id) => !diagnostics.get(id)?.closed)
        .map((sessionId) => desktop.request({ type: "disconnect", sessionId }, undefined, 5000)));
      const deadline = Date.now() + 2000;
      while (!cliCleanupEvidence().confirmed && Date.now() < deadline) await delay(50);
    }
    if (desktop && !desktop.closed && daemon?.exitCode === null) await desktop.request({ type: "shutdown" }, undefined, 5000).catch(() => {});
    for (const peer of peers) peer.close();
    for (const responder of terminalResponders.values()) responder.dispose();
    for (const diagnostic of diagnostics.values()) diagnostic.taskResponder?.dispose();
    await delay(400);
    // Only live child handles created above are eligible, never discovered
    // provider processes, process names, or the user's background service.
    for (const child of children) {
      if (child.exitCode !== null || !child.pid) continue;
      const killer = spawn(join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
        ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      await new Promise((done) => {
        const timer = setTimeout(() => { killer.kill(); report.passed = false; report.cleanup = "owned-process-cleanup-unconfirmed"; done(); }, 10000);
        killer.once("exit", () => { clearTimeout(timer); done(); });
        killer.once("error", () => { clearTimeout(timer); report.passed = false; report.cleanup = "owned-process-cleanup-unconfirmed"; done(); });
      });
    }
    const cleanupDeadline = Date.now() + 2000;
    while (children.size > 0 && Date.now() < cleanupDeadline) await delay(50);
    if (children.size > 0) { report.cleanup = "owned-process-cleanup-unconfirmed"; report.passed = false; }
    const cliDeadline = Date.now() + 2000;
    while (!cliCleanupEvidence().confirmed && Date.now() < cliDeadline) await delay(50);
    report.ownedCliCleanup = cliCleanupEvidence();
    if (!report.ownedCliCleanup.confirmed) {
      report.cleanup = "owned-cli-cleanup-unconfirmed-fixtures-retained";
      report.passed = false;
    }
    if (root) {
      const parent = realpathSync.native(tmpdir()).replace(/^\\\\\?\\/, "");
      if (dirname(root).toLowerCase() !== parent.toLowerCase() || !basename(root).startsWith("lattice-mcp-live-") || lstatSync(root).isSymbolicLink()) {
        report.cleanup = "refused-unexpected-temporary-path"; report.passed = false;
      } else if (report.ownedCliCleanup.confirmed) {
        try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); report.cleanup ||= "owned-cli-pids-and-launchers-exited-fixtures-removed"; }
        catch { report.cleanup = "temporary-files-remain"; report.passed = false; }
      }
    } else report.cleanup = "no-live-fixtures-created";
    process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal);
    report.finishedAt = new Date().toISOString();
    const json = JSON.stringify(report, null, 2) + "\n";
    if (options.report) writeFileSync(options.report, json, { flag: "wx", mode: 0o600 });
    console.log(json);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // Read the report only AFTER finally: cleanup failure must also fail a
  // preflight that returned early from its verification phase.
  main(process.argv.slice(2)).then((result) => { process.exitCode = typeof result === "number" ? result : result.passed ? 0 : 1; }, () => {
    console.error("Acceptance infrastructure failed; no raw CLI output or credentials were printed."); process.exitCode = 1;
  });
}
