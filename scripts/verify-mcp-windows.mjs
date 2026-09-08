// Windows acceptance against an actual desktop/CI executable, without installing it.
// Usage: node scripts/verify-mcp-windows.mjs <lattice-term.exe> [report.json] [--external-reporter]
// All sessions, tokens and plans belong to a fresh temporary data directory.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { arch, release, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

if (process.platform !== "win32" || !process.argv[2])
  throw Error("Pass a Windows LatticeTerm executable.");
const executable = resolve(process.argv[2]);
const options = process.argv.slice(3);
const externalReporter = options.includes("--external-reporter");
const reportArguments = options.filter(
  (value) => value !== "--external-reporter",
);
if (
  reportArguments.length > 1 ||
  reportArguments.some((value) => value.startsWith("--"))
)
  throw Error("Pass at most one report path and --external-reporter");
const reportPath = reportArguments[0];
const root = mkdtempSync(join(tmpdir(), "latticeterm-mcp-win-"));
const dataDir = join(root, "Isolated Data");
mkdirSync(dataDir);
const inputLog = join(root, "input.txt");
const fixture = join(root, "fixture.cmd");
// Only the fixed ASCII prompts below reach this shell fixture.
writeFileSync(
  fixture,
  [
    "@echo off",
    // Only the isolated fixture's credentials are exported, never user accounts.
    ...(externalReporter
      ? [
          '>"report-%LATTICETERM_AGENT_SESSION%.json" echo {"LATTICETERM_AGENT_REPORT_ADDR":"%LATTICETERM_AGENT_REPORT_ADDR%","LATTICETERM_AGENT_SESSION":"%LATTICETERM_AGENT_SESSION%","LATTICETERM_AGENT_REPORT_TOKEN":"%LATTICETERM_AGENT_REPORT_TOKEN%"}',
        ]
      : []),
    "echo MCP_FIXTURE_READY",
    ":read",
    'set "line="',
    'set /p "line="',
    "if not defined line goto read",
    ">>input.txt echo %line%",
    "echo ECHO:%line%",
    'if "%line%"=="READY_FIXTURE" "%LATTICETERM_AGENT_REPORTER%" agent-report idle',
    'if "%line%"=="EXIT_FIXTURE" exit /b 0',
    "goto read",
    "",
  ].join("\r\n"),
);

const report = {
  platform: `Windows ${release()} ${arch()}`,
  lifecycleReporter: externalReporter
    ? "external fixture callback"
    : "ConPTY fixture callback",
  executableSha256: createHash("sha256")
    .update(readFileSync(executable))
    .digest("hex"),
  checks: [],
};
const children = new Set();
const clients = new Set();
function child(args, env = process.env) {
  const p = spawn(executable, args, {
    cwd: root,
    windowsHide: true,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(p);
  p.stderr.on("data", () => {});
  p.on("exit", () => children.delete(p));
  return p;
}
class JsonPeer extends EventEmitter {
  constructor(reader, writer, mode) {
    super();
    this.writer = writer;
    this.mode = mode;
    this.pending = new Map();
    this.next = 1;
    this.buffer = "";
    reader.setEncoding("utf8");
    reader.on("data", (data) => {
      this.buffer += data;
      for (let end; (end = this.buffer.indexOf("\n")) >= 0; ) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          this.emit("invalid");
          continue;
        }
        if (mode === "daemon" && message.kind === "event") {
          this.emit("event", message);
          continue;
        }
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if ((mode === "daemon" && !message.ok) || message.error)
          pending.reject(
            Error(
              typeof message.error === "string"
                ? message.error
                : message.error?.message || "Request failed",
            ),
          );
        else pending.resolve(message.result);
      }
    });
    const closed = () => {
      for (const wait of this.pending.values()) {
        clearTimeout(wait.timer);
        wait.reject(Error("Peer closed"));
      }
      this.pending.clear();
    };
    reader.on("error", closed);
    reader.on("end", closed);
    if (writer !== reader) writer.on("error", closed);
  }
  request(body, params) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          Error(
            `Request timeout: ${this.mode === "daemon" ? body.type : body}`,
          ),
        );
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.writer.write(
        JSON.stringify(
          this.mode === "daemon"
            ? { kind: "request", id, body }
            : { jsonrpc: "2.0", id, method: body, params },
        ) + "\n",
      );
    });
  }
  call(name, args = {}) {
    return this.request("tools/call", { name, arguments: args });
  }
  close() {
    this.writer.end();
  }
}
const ok = (value) => {
  assert.equal(value.isError, false, JSON.stringify(value.content));
  return value.structuredContent;
};
function pipeName(directory) {
  // Match Rust canonicalize/GetFinalPathNameByHandle, including CI's RUNNER~1
  // temporary path. The JavaScript realpath implementation retains 8.3 aliases.
  const key = realpathSync
    .native(directory)
    .replace(/^\\\\\?\\/, "")
    .replaceAll("/", "\\")
    .replace(/\\+$/, "")
    .toLowerCase();
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(key))
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return `\\\\.\\pipe\\latticeterm-agent-${hash.toString(16).padStart(16, "0")}`;
}
async function waitUntil(predicate, label, timeout = 10000) {
  const end = Date.now() + timeout;
  do {
    const value = await predicate();
    if (value) return value;
    await delay(40);
  } while (Date.now() < end);
  throw Error(`Timed out: ${label}`);
}
async function daemonPeer(role = "desktop") {
  const socket = await waitUntil(
    () =>
      new Promise((resolve) => {
        const s = createConnection(pipeName(dataDir));
        s.once("connect", () => resolve(s));
        s.once("error", () => {
          s.destroy();
          resolve(null);
        });
      }),
    "named pipe",
  );
  const peer = new JsonPeer(socket, socket, "daemon");
  clients.add(peer);
  await peer.request({
    type: "hello",
    protocol: 1,
    token: readFileSync(join(dataDir, "agent-daemon.token"), "utf8").trim(),
    role,
    client: "windows-acceptance 1.0",
  });
  return peer;
}
async function mcp(directory = dataDir, name = "windows-acceptance") {
  const p = child(["mcp", "--data-dir", directory]);
  const peer = new JsonPeer(p.stdout, p.stdin, "mcp");
  clients.add(peer);
  await peer.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name, version: "1.0" },
  });
  p.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
      "\n",
  );
  return peer;
}
const launchRequest = {
  definitionId: "custom",
  label: "Windows MCP fixture",
  executable: process.env.ComSpec,
  arguments: ["/d", "/q", "/c", fixture],
  workingDirectory: root,
  cols: 120,
  rows: 32,
  sandbox: false,
  detached: true,
};
let desktop, daemon, adapter;
const output = new Map();
const allEvents = [];
async function launch(restoredOutput = "") {
  const session = await desktop.request({
    type: "launch",
    request: launchRequest,
    restoredOutput: restoredOutput
      ? Buffer.from(restoredOutput).toString("base64")
      : null,
  });
  await waitUntil(() => {
    const closed = allEvents.find(
      (e) => e.name === "closed" && e.payload.sessionId === session.sessionId,
    );
    if (closed) throw Error(closed.payload.reason);
    return output.get(session.sessionId)?.includes("MCP_FIXTURE_READY");
  }, "ConPTY ready");
  await delay(250);
  return session.sessionId;
}
async function share(id, control = false) {
  await desktop.request({ type: "shareSet", sessionId: id, shared: true });
  if (control)
    await desktop.request({ type: "controlSet", sessionId: id, control: true });
}
async function check(id, action) {
  try {
    const evidence = await action();
    report.checks.push({ id, status: "passed", evidence });
    console.log(`PASS ${id}`);
  } catch (error) {
    report.checks.push({ id, status: "failed", error: error.message });
    console.log(`FAIL ${id}: ${error.message.slice(0, 500)}`);
  }
}
try {
  daemon = child(["agent-daemon", "--data-dir", dataDir]);
  await waitUntil(
    () => existsSync(join(dataDir, "agent-daemon.token")),
    "daemon token",
  );
  desktop = await daemonPeer();
  desktop.on("event", (event) => {
    allEvents.push(event);
    if (event.name !== "data") return;
    const id = event.payload.sessionId,
      text = Buffer.from(event.payload.base64, "base64").toString();
    const before = output.get(id) || "";
    output.set(id, (before + text).slice(-300000));
    if ((before.slice(-3) + text).includes("\x1b[6n"))
      void waitUntil(
        () =>
          desktop
            .request({
              type: "send",
              sessionId: id,
              data: Buffer.from("\x1b[1;1R").toString("base64"),
            })
            .then(() => true)
            .catch(() => false),
        "cursor report",
      ).catch(() => {});
  });
  adapter = await mcp();
  const plain = await launch();
  const hidden = await launch();
  await share(plain);
  await check("A tools and sharing", async () => {
    const tools = await adapter.request("tools/list", {});
    assert.equal(tools.tools.length, 8);
    const list = ok(await adapter.call("list_agent_sessions"));
    assert.deepEqual(
      list.sessions.map((s) => s.sessionId),
      [plain],
    );
    for (const key of [
      "executable",
      "launchArguments",
      "profileConfigPath",
      "processId",
      "capturedSessionId",
    ])
      assert.equal(key in list.sessions[0], false, key);
    assert.equal(
      (await adapter.call("read_agent_output", { sessionId: hidden })).isError,
      true,
    );
    return {
      tools: tools.tools.length,
      onlySharedVisible: true,
      privateFieldsAbsent: true,
    };
  });
  await check(
    "F1 revoke wakes wait and does not block following requests",
    async () => {
      let settled = false;
      const waiting = adapter
        .call("wait_agent_state", { sessionId: plain, timeoutMs: 5000 })
        .then((r) => {
          settled = true;
          return r;
        });
      await delay(150);
      const listStart = Date.now();
      ok(await adapter.call("list_agent_sessions"));
      const listMs = Date.now() - listStart;
      assert.ok(listMs < 1000, `list took ${listMs}ms`);
      assert.equal(settled, false);
      const revokeStart = Date.now();
      await desktop.request({
        type: "shareSet",
        sessionId: plain,
        shared: false,
      });
      const result = ok(await waiting),
        revokeMs = Date.now() - revokeStart;
      assert.equal(result.revoked, true);
      assert.equal(result.timedOut, false);
      assert.ok(revokeMs < 1000, `revocation took ${revokeMs}ms`);
      assert.equal(
        (await adapter.call("read_agent_output", { sessionId: plain })).isError,
        true,
      );
      await share(plain);
      return { listMs, revokeMs, revoked: true };
    },
  );
  const ansiFixture = "x".repeat(16382) + "\x1b[31mRED\x1b[0m\n中文\n";
  const ansi = await launch(ansiFixture);
  await share(ansi);
  await check("F2 default ANSI page boundary", async () => {
    const first = ok(
      await adapter.call("read_agent_output", { sessionId: ansi }),
    );
    const second = ok(
      await adapter.call("read_agent_output", {
        sessionId: ansi,
        cursor: first.nextCursor,
      }),
    );
    assert.equal(first.nextCursor, 16382);
    assert.equal(first.text.length, 16382);
    assert.ok(second.text.startsWith("RED\n中文\n"));
    return {
      firstCursor: first.nextCursor,
      secondPrefix: second.text.slice(0, 7),
    };
  });
  await check("F3 UTF-8 small pages advance", async () => {
    const samples = ["é", "中", "😀"];
    const evidence = [];
    const id = await launch(samples.join(""));
    await share(id);
    let cursor = 0;
    for (const sample of samples) {
      const page = ok(
        await adapter.call("read_agent_output", {
          sessionId: id,
          cursor,
          maxBytes: 1,
        }),
      );
      assert.equal(page.text, sample);
      assert.equal(page.nextCursor - cursor, Buffer.byteLength(sample));
      evidence.push({ text: sample, advance: page.nextCursor - cursor });
      cursor = page.nextCursor;
    }
    return evidence;
  });
  await check("F4 equivalent Windows paths find the same daemon", async () => {
    const variants = [
      dataDir,
      dataDir.replaceAll("\\", "/"),
      dataDir.toLowerCase(),
      dataDir.toUpperCase(),
      dataDir + "\\",
      "\\\\?\\" + dataDir,
      dataDir + "\\..\\Isolated Data",
      ".\\Isolated Data",
    ];
    for (const directory of variants) {
      const client = await mcp(directory);
      const caps = ok(await client.call("get_capabilities"));
      assert.equal(caps.daemonRunning, true);
      const sessions = ok(await client.call("list_agent_sessions")).sessions;
      assert.ok(sessions.some((s) => s.sessionId === plain));
      client.close();
    }
    const other = join(root, "other-data");
    mkdirSync(other);
    const isolated = await mcp(other);
    assert.equal(
      ok(await isolated.call("get_capabilities")).daemonRunning,
      false,
    );
    isolated.close();
    return {
      equivalentForms: variants.length,
      differentDirectoryIsolated: true,
    };
  });
  await check(
    "B independent grants, queue, prompt deduplication and revocation",
    async () => {
      assert.equal(
        (
          await adapter.call("send_agent_prompt", {
            sessionId: plain,
            text: "DENIED",
            mode: "now",
            requestId: "read-only-prompt",
          })
        ).isError,
        true,
      );
      assert.equal(
        (
          await adapter.call("cancel_agent_task", {
            sessionId: plain,
            scope: "session",
            requestId: "read-only-cancel",
          })
        ).isError,
        true,
      );
      assert.equal(ok(await adapter.call("list_launch_plans")).enabled, false);
      assert.equal(
        (
          await adapter.call("launch_agent", {
            planId: "missing",
            requestId: "disabled-launch",
          })
        ).isError,
        true,
      );
      await desktop.request({
        type: "controlSet",
        sessionId: plain,
        control: true,
      });
      const prompt = {
        sessionId: plain,
        text: "ONCE_FIXTURE",
        mode: "now",
        requestId: "send-once",
      };
      // The fixture emulates a lifecycle hook through the actual authenticated
      // reporter CLI. This verifies transport, not a real AI provider's hook.
      assert.equal(
        (
          await adapter.call("send_agent_prompt", {
            ...prompt,
            requestId: "unready-now",
          })
        ).isError,
        true,
      );
      if (externalReporter) {
        const credentials = JSON.parse(
          readFileSync(join(root, `report-${plain}.json`), "utf8"),
        );
        assert.equal(credentials.LATTICETERM_AGENT_SESSION, plain);
        if (
          !/^(127\.0\.0\.1|\[::1\]):\d+$/.test(
            credentials.LATTICETERM_AGENT_REPORT_ADDR,
          )
        )
          throw Error("The fixture reporter must use loopback");
        if (
          !/^[A-Za-z0-9_-]+$/.test(credentials.LATTICETERM_AGENT_REPORT_TOKEN)
        )
          throw Error("Invalid fixture reporter token");
        const reporter = child(["agent-report", "idle"], {
          ...process.env,
          LATTICETERM_AGENT_SESSION: plain,
          LATTICETERM_AGENT_REPORT_ADDR:
            credentials.LATTICETERM_AGENT_REPORT_ADDR,
          LATTICETERM_AGENT_REPORT_TOKEN:
            credentials.LATTICETERM_AGENT_REPORT_TOKEN,
        });
        const exitCode = await new Promise((resolve) =>
          reporter.once("exit", resolve),
        );
        assert.equal(
          exitCode,
          0,
          "fixture reporter must acknowledge readiness",
        );
      } else {
        await desktop.request({
          type: "send",
          sessionId: plain,
          data: Buffer.from("READY_FIXTURE\r").toString("base64"),
        });
      }
      await waitUntil(
        async () =>
          ok(await adapter.call("list_agent_sessions")).sessions.some(
            (s) =>
              s.sessionId === plain &&
              s.state === "idle" &&
              s.stateSource === "integration",
          ),
        "fixture lifecycle report",
      );
      const first = ok(await adapter.call("send_agent_prompt", prompt));
      assert.equal(first.sentImmediately, true);
      const duplicate = ok(await adapter.call("send_agent_prompt", prompt));
      assert.equal(duplicate.duplicate, true);
      await waitUntil(
        () =>
          existsSync(inputLog) &&
          readFileSync(inputLog, "utf8").includes("ONCE_FIXTURE"),
        "PTY input",
      );
      await delay(100);
      assert.equal(
        readFileSync(inputLog, "utf8")
          .split("\n")
          .filter((line) => line.includes("ONCE_FIXTURE")).length,
        1,
      );
      assert.equal(
        (
          await adapter.call("send_agent_prompt", {
            sessionId: plain,
            text: "BUSY_FIXTURE",
            mode: "now",
            requestId: "busy-now",
          })
        ).isError,
        true,
      );
      assert.equal(
        readFileSync(inputLog, "utf8").includes("BUSY_FIXTURE"),
        false,
      );
      const queued = ok(
        await adapter.call("send_agent_prompt", {
          sessionId: plain,
          text: "QUEUED_FIXTURE",
          mode: "queue",
          requestId: "queue-one",
        }),
      );
      assert.equal(queued.queued, 1);
      const cleared = ok(
        await adapter.call("cancel_agent_task", {
          sessionId: plain,
          scope: "queue",
          requestId: "clear-one",
        }),
      );
      assert.equal(cleared.dropped, 1);
      assert.equal(
        readFileSync(inputLog, "utf8").includes("QUEUED_FIXTURE"),
        false,
      );
      await desktop.request({
        type: "controlSet",
        sessionId: plain,
        control: false,
      });
      assert.equal(
        (
          await adapter.call("send_agent_prompt", {
            sessionId: plain,
            text: "REVOKED",
            mode: "now",
            requestId: "revoked-prompt",
          })
        ).isError,
        true,
      );
      assert.ok(
        ok(await adapter.call("list_agent_sessions")).sessions.some(
          (s) => s.sessionId === plain && s.access === "read",
        ),
      );
      return {
        readDoesNotGrantControl: true,
        nowDeliveredOnce: true,
        queueCleared: 1,
        controlRevoked: true,
      };
    },
  );
  await check("B saved plan launch and session cancellation", async () => {
    await desktop.request({
      type: "mcpPlansReplace",
      enabled: true,
      plans: [
        {
          planId: "fixture-plan",
          label: "Windows fixture",
          note: "Local acceptance only",
          definitionId: "custom",
          workingDirectory: root,
          sandbox: false,
          request: launchRequest,
        },
      ],
    });
    const plans = ok(await adapter.call("list_launch_plans"));
    assert.equal(plans.plans.length, 1);
    assert.equal("request" in plans.plans[0], false);
    assert.equal("arguments" in plans.plans[0], false);
    const args = { planId: "fixture-plan", requestId: "launch-once" };
    const first = ok(await adapter.call("launch_agent", args));
    const id = first.session.sessionId;
    assert.equal(first.session.access, "control");
    await waitUntil(
      () =>
        allEvents.some(
          (e) => e.name === "launched" && e.payload.sessionId === id,
        ),
      "launch visible to desktop",
    );
    const again = ok(await adapter.call("launch_agent", args));
    assert.equal(again.duplicate, true);
    assert.equal(again.session.sessionId, id);
    const wait = adapter.call("wait_agent_state", {
      sessionId: id,
      timeoutMs: 5000,
    });
    await delay(150);
    const ended = ok(
      await adapter.call("cancel_agent_task", {
        sessionId: id,
        scope: "session",
        requestId: "cancel-one",
      }),
    );
    assert.equal(ended.ended, true);
    const closed = ok(await wait);
    assert.equal(closed.closed, true);
    const pid = allEvents.find(
      (e) => e.name === "launched" && e.payload.sessionId === id,
    ).payload.processId;
    assert.ok(Number.isInteger(pid));
    await waitUntil(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        if (error.code === "ESRCH") return true;
        throw error;
      }
    }, "cancelled process exited");
    assert.equal(
      ok(await adapter.call("list_agent_sessions")).sessions.some(
        (s) => s.sessionId === id,
      ),
      false,
    );
    assert.ok(
      (await desktop.request({ type: "sessions" })).some(
        (s) => s.sessionId === hidden,
      ),
    );
    return {
      savedPlanOnly: true,
      launchDeliveredOnce: true,
      desktopNotified: true,
      closed: true,
      processExited: true,
      otherSessionPreserved: true,
    };
  });
  await check(
    "B concurrent retries across connections launch only once",
    async () => {
      const second = await mcp();
      const args = { planId: "fixture-plan", requestId: "parallel-launch" };
      const results = await Promise.all([
        adapter.call("launch_agent", args),
        adapter.call("launch_agent", args),
        second.call("launch_agent", args),
        second.call("launch_agent", args),
      ]);
      const ids = results.map((r) => ok(r).session.sessionId);
      assert.equal(
        new Set(ids).size,
        1,
        "Concurrent retries launched separate sessions",
      );
      assert.equal(results.filter((r) => ok(r).duplicate).length, 3);
      second.close();
      return { requests: 4, sessions: new Set(ids).size };
    },
  );
  await check("F1 daemon loss is an error", async () => {
    const id = await launch();
    await share(id);
    let settled = false;
    const wait = adapter
      .call("wait_agent_state", { sessionId: id, timeoutMs: 5000 })
      .then((result) => {
        settled = true;
        return result;
      });
    await delay(150);
    assert.equal(
      settled,
      false,
      "the idle fixture must still be waiting before disconnection",
    );
    const start = Date.now();
    daemon.kill();
    const result = await wait;
    assert.equal(result.isError, true, JSON.stringify(result));
    const lossMs = Date.now() - start;
    assert.ok(lossMs < 1000, `daemon loss took ${lossMs}ms`);
    return { daemonLossIsError: true, lossMs };
  });
} catch (error) {
  report.checks.push({
    id: "test infrastructure",
    status: "failed",
    error: error.message,
  });
} finally {
  if (desktop && !desktop.writer.destroyed && daemon?.exitCode === null)
    await desktop.request({ type: "shutdown" }).catch(() => {});
  for (const client of clients) client.close();
  await delay(300);
  for (const p of children) p.kill();
  // The only recursive removal is the directory minted above by this run.
  const expectedPrefix = resolve(tmpdir()) + sep + "latticeterm-mcp-win-";
  if (resolve(root).startsWith(expectedPrefix)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      report.cleanup = "Some fixture files remain in the temporary directory.";
    }
  }
}
report.passed = report.checks.every((check) => check.status === "passed");
if (reportPath)
  writeFileSync(resolve(reportPath), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
