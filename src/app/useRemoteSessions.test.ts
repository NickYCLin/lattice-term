import { describe, expect, it } from "vitest";
import {
  MAX_REMOTE_TERMINAL_PENDING_BYTES,
  RemoteConnectRaceGuard,
  RemoteEventReadinessGate,
  RemoteTerminalOutputRouter,
  reconcileRemoteFileTransfer,
  reconcileRemoteTerminalOutput,
  remoteReconnectRequest,
  runRemoteReconnect,
  settleRemoteConnectOutcome,
  streamRemoteFileUpload,
  type RemoteConnectOutcome,
  type RemoteFileTransfer,
} from "./useRemoteSessions";

function payload(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function joined(chunks: readonly Uint8Array[]): string {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

const connectedOutcome: RemoteConnectOutcome = {
  outcome: "connected",
  sessionId: "remote-fast",
  profileId: "profile-1",
  host: "host.example",
  port: 54921,
  viaRelay: false,
  agentName: "Build host",
  width: 0,
  height: 0,
  viewOnly: false,
  fileTransfer: true,
  fileRootLabel: "Shared files",
  terminal: true,
};

function transfer(
  state: RemoteFileTransfer["state"],
  bytesDone: number,
): RemoteFileTransfer {
  return {
    transferId: "remote-file-1",
    sessionId: "remote-1",
    kind: "upload",
    name: "data.bin",
    remotePath: "/data.bin",
    localPath: null,
    bytesDone,
    totalBytes: 100,
    state,
    detail: null,
  };
}

describe("Lattice Remote file uploads", () => {
  it("splits browser streams at the encrypted protocol boundary", async () => {
    const commands: Array<{ command: string; data?: string }> = [];
    const bytes = new Uint8Array(48 * 1024 + 7).fill(0x5a);
    await streamRemoteFileUpload(
      new Blob([bytes]),
      "remote-1",
      "remote-file-1",
      async (command, args) => {
        commands.push({ command, data: args?.data as string | undefined });
      },
    );

    expect(commands.map(({ command }) => command)).toEqual([
      "remote_file_upload_chunk",
      "remote_file_upload_chunk",
      "remote_file_upload_finish",
    ]);
    expect(atob(commands[0].data!).length).toBe(48 * 1024);
    expect(atob(commands[1].data!).length).toBe(7);
  });

  it("cancels the remote staging file when streaming fails", async () => {
    const commands: string[] = [];
    await expect(
      streamRemoteFileUpload(
        new Blob([new Uint8Array([1, 2, 3])]),
        "remote-1",
        "remote-file-2",
        async (command) => {
          commands.push(command);
          if (command === "remote_file_upload_chunk") {
            throw new Error("connection closed");
          }
        },
      ),
    ).rejects.toThrow("connection closed");
    expect(commands).toEqual([
      "remote_file_upload_chunk",
      "remote_file_transfer_cancel",
    ]);
  });
});

describe("Lattice Remote transfer event reconciliation", () => {
  it("keeps completed state over a late initial response", () => {
    const completed = transfer("done", 100);
    expect(reconcileRemoteFileTransfer(completed, transfer("running", 0))).toBe(
      completed,
    );
  });

  it("keeps the furthest running byte count", () => {
    const newer = transfer("running", 80);
    expect(reconcileRemoteFileTransfer(newer, transfer("running", 20))).toBe(
      newer,
    );
  });
});

describe("Lattice Remote terminal output", () => {
  it("orders live events and trims their overlap with a snapshot", () => {
    const chunks = reconcileRemoteTerminalOutput(
      {
        sessionId: "remote-1",
        startOffset: 0,
        endOffset: 4,
        base64: payload("abcd"),
      },
      [
        { sessionId: "remote-1", offset: 6, base64: payload("gh") },
        { sessionId: "remote-1", offset: 2, base64: payload("cdef") },
      ],
    );

    expect(chunks.map((chunk) => chunk.offset)).toEqual([0, 4, 6]);
    expect(joined(chunks.map((chunk) => chunk.bytes))).toBe("abcdefgh");
  });

  it("preserves live bytes older than a truncated snapshot tail", () => {
    const chunks = reconcileRemoteTerminalOutput(
      {
        sessionId: "remote-1",
        startOffset: 4,
        endOffset: 8,
        base64: payload("tail"),
      },
      [{ sessionId: "remote-1", offset: 0, base64: payload("old-") }],
    );

    expect(joined(chunks.map((chunk) => chunk.bytes))).toBe("old-tail");
  });

  it("rejects invalid offsets, lengths, base64, and oversized payloads", () => {
    expect(() =>
      reconcileRemoteTerminalOutput(
        {
          sessionId: "remote-1",
          startOffset: 0,
          endOffset: 8,
          base64: payload("short"),
        },
        [],
      ),
    ).toThrow("offsets are inconsistent");
    expect(() =>
      reconcileRemoteTerminalOutput(null, [
        { sessionId: "remote-1", offset: -1, base64: payload("x") },
      ]),
    ).toThrow("offset is invalid");
    expect(() =>
      reconcileRemoteTerminalOutput(null, [
        { sessionId: "remote-1", offset: 0, base64: "!!!!" },
      ]),
    ).toThrow("not valid base64");
    expect(() =>
      reconcileRemoteTerminalOutput(null, [
        {
          sessionId: "remote-1",
          offset: 0,
          base64: "A".repeat(
            Math.ceil(MAX_REMOTE_TERMINAL_PENDING_BYTES / 3) * 4 + 1,
          ),
        },
      ]),
    ).toThrow("safe size limit");
  });

  it("registers before hydration and flushes reconciled data in order", () => {
    const router = new RemoteTerminalOutputRouter();
    const received: Uint8Array[] = [];
    router.onData("remote-1", (bytes) => received.push(bytes));
    router.observe({
      sessionId: "remote-1",
      offset: 4,
      base64: payload("efgh"),
    });
    router.observe({
      sessionId: "remote-1",
      offset: 2,
      base64: payload("cdef"),
    });

    expect(received).toHaveLength(0);
    router.completeHydration([
      {
        sessionId: "remote-1",
        startOffset: 0,
        endOffset: 4,
        base64: payload("abcd"),
      },
    ]);
    expect(joined(received)).toBe("abcdefgh");
  });

  it("flushes only the bounded tail synchronously when a pane mounts", () => {
    const router = new RemoteTerminalOutputRouter(6);
    router.completeHydration([]);
    router.observe({
      sessionId: "remote-1",
      offset: 0,
      base64: payload("abcdefghij"),
    });

    const received: Uint8Array[] = [];
    router.onData("remote-1", (bytes) => received.push(bytes));
    expect(joined(received)).toBe("efghij");

    router.observe({
      sessionId: "remote-1",
      offset: 10,
      base64: payload("kl"),
    });
    expect(joined(received)).toBe("efghijkl");

    const remounted: Uint8Array[] = [];
    router.onData("remote-1", (bytes) => remounted.push(bytes));
    expect(joined(remounted)).toBe("ghijkl");
  });

  it("replays retained history after StrictMode cleanup and remount", () => {
    const router = new RemoteTerminalOutputRouter();
    router.completeHydration([]);
    router.observe({
      sessionId: "remote-1",
      offset: 0,
      base64: payload("BOOT\r\n"),
    });

    const firstMount: Uint8Array[] = [];
    const stopFirst = router.onData("remote-1", (bytes) =>
      firstMount.push(bytes),
    );
    expect(joined(firstMount)).toBe("BOOT\r\n");
    stopFirst();

    const secondMount: Uint8Array[] = [];
    router.onData("remote-1", (bytes) => secondMount.push(bytes));
    expect(joined(secondMount)).toBe("BOOT\r\n");
  });

  it("retains active output for later handlers without duplicating live data", () => {
    const router = new RemoteTerminalOutputRouter();
    router.completeHydration([]);
    const first: Uint8Array[] = [];
    router.onData("remote-1", (bytes) => first.push(bytes));
    router.observe({
      sessionId: "remote-1",
      offset: 0,
      base64: payload("boot"),
    });

    const second: Uint8Array[] = [];
    router.onData("remote-1", (bytes) => second.push(bytes));
    expect(joined(first)).toBe("boot");
    expect(joined(second)).toBe("boot");

    router.observe({
      sessionId: "remote-1",
      offset: 4,
      base64: payload("!"),
    });
    expect(joined(first)).toBe("boot!");
    expect(joined(second)).toBe("boot!");
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
  });

  it("bounds persistent history by chunk count without dropping active live data", () => {
    const router = new RemoteTerminalOutputRouter(1024, 4);
    router.completeHydration([]);
    const active: Uint8Array[] = [];
    const stopActive = router.onData("remote-1", (bytes) => active.push(bytes));

    for (let offset = 0; offset < 10; offset += 1) {
      router.observe({
        sessionId: "remote-1",
        offset,
        base64: payload(String(offset)),
      });
    }
    expect(joined(active)).toBe("0123456789");
    expect(active).toHaveLength(10);
    stopActive();

    const remounted: Uint8Array[] = [];
    router.onData("remote-1", (bytes) => remounted.push(bytes));
    expect(joined(remounted)).toBe("6789");
    expect(remounted).toHaveLength(4);
  });

  it("bounds one-byte hydration floods by chunk count", () => {
    const router = new RemoteTerminalOutputRouter(1024, 4);
    for (let offset = 0; offset < 10; offset += 1) {
      router.observe({
        sessionId: "remote-1",
        offset,
        base64: payload(String(offset)),
      });
    }
    router.completeHydration([]);

    const received: Uint8Array[] = [];
    router.onData("remote-1", (bytes) => received.push(bytes));
    expect(joined(received)).toBe("6789");
    expect(received).toHaveLength(4);
  });

  it("merges a snapshot with the bounded hydration tail by offset", () => {
    const router = new RemoteTerminalOutputRouter(1024, 4);
    for (let offset = 0; offset < 10; offset += 1) {
      router.observe({
        sessionId: "remote-1",
        offset,
        base64: payload(String(offset)),
      });
    }
    router.completeHydration([
      {
        sessionId: "remote-1",
        startOffset: 0,
        endOffset: 8,
        base64: payload("01234567"),
      },
    ]);

    const received: Uint8Array[] = [];
    router.onData("remote-1", (bytes) => received.push(bytes));
    expect(joined(received)).toBe("0123456789");
    expect(received).toHaveLength(3);
  });

  it("rejects invalid injected chunk limits", () => {
    expect(() => new RemoteTerminalOutputRouter(1024, 0)).toThrow(
      "chunk limit must be positive",
    );
    expect(() => new RemoteTerminalOutputRouter(1024, 1.5)).toThrow(
      "chunk limit must be positive",
    );
  });

  it("fills remount history without replaying old snapshot bytes to an active pane", () => {
    const router = new RemoteTerminalOutputRouter();
    router.completeHydration([]);
    const active: Uint8Array[] = [];
    const stopActive = router.onData("remote-1", (bytes) => active.push(bytes));
    router.observe({
      sessionId: "remote-1",
      offset: 4,
      base64: payload("efgh"),
    });
    router.replaySnapshot({
      sessionId: "remote-1",
      startOffset: 0,
      endOffset: 6,
      base64: payload("abcdef"),
    });

    expect(joined(active)).toBe("efgh");
    expect(active).toHaveLength(1);
    stopActive();

    const remounted: Uint8Array[] = [];
    router.onData("remote-1", (bytes) => remounted.push(bytes));
    expect(joined(remounted)).toBe("abcdefgh");
  });

  it("replays an older startup snapshot before live output that arrived first", () => {
    const router = new RemoteTerminalOutputRouter();
    router.completeHydration([]);
    router.observe({
      sessionId: "remote-1",
      offset: 4,
      base64: payload("efgh"),
    });

    expect(
      router.replaySnapshot({
        sessionId: "remote-1",
        startOffset: 0,
        endOffset: 6,
        base64: payload("abcdef"),
      }),
    ).toBe(true);
    const received: Uint8Array[] = [];
    router.onData("remote-1", (bytes) => received.push(bytes));
    expect(joined(received)).toBe("abcdefgh");
  });

  it("deduplicates live output already covered by a newer startup snapshot", () => {
    const router = new RemoteTerminalOutputRouter();
    router.completeHydration([]);
    router.observe({
      sessionId: "remote-1",
      offset: 0,
      base64: payload("abcd"),
    });
    router.replaySnapshot({
      sessionId: "remote-1",
      startOffset: 0,
      endOffset: 8,
      base64: payload("abcdefgh"),
    });

    const received: Uint8Array[] = [];
    router.onData("remote-1", (bytes) => received.push(bytes));
    expect(joined(received)).toBe("abcdefgh");
  });

  it("deduplicates a replay when live output follows the snapshot", () => {
    const router = new RemoteTerminalOutputRouter();
    router.completeHydration([]);
    router.replaySnapshot({
      sessionId: "remote-1",
      startOffset: 0,
      endOffset: 4,
      base64: payload("abcd"),
    });
    router.observe({
      sessionId: "remote-1",
      offset: 2,
      base64: payload("cdef"),
    });
    router.replaySnapshot({
      sessionId: "remote-1",
      startOffset: 0,
      endOffset: 6,
      base64: payload("abcdef"),
    });

    const received: Uint8Array[] = [];
    router.onData("remote-1", (bytes) => received.push(bytes));
    expect(joined(received)).toBe("abcdef");
  });

  it("merges startup replay with live chunks still queued by hydration", () => {
    const router = new RemoteTerminalOutputRouter();
    router.observe({
      sessionId: "remote-1",
      offset: 4,
      base64: payload("efgh"),
    });
    router.replaySnapshot({
      sessionId: "remote-1",
      startOffset: 0,
      endOffset: 6,
      base64: payload("abcdef"),
    });
    router.completeHydration([
      {
        sessionId: "remote-1",
        startOffset: 0,
        endOffset: 8,
        base64: payload("abcdefgh"),
      },
    ]);

    const received: Uint8Array[] = [];
    router.onData("remote-1", (bytes) => received.push(bytes));
    expect(joined(received)).toBe("abcdefgh");
  });

  it("keeps live pending data when startup replay is malformed", () => {
    const router = new RemoteTerminalOutputRouter();
    router.completeHydration([]);
    router.observe({
      sessionId: "remote-1",
      offset: 0,
      base64: payload("live"),
    });
    expect(
      router.replaySnapshot({
        sessionId: "remote-1",
        startOffset: 0,
        endOffset: 99,
        base64: payload("bad"),
      }),
    ).toBe(false);

    const received: Uint8Array[] = [];
    router.onData("remote-1", (bytes) => received.push(bytes));
    expect(joined(received)).toBe("live");
  });

  it("bounds live data while hydration is still waiting for snapshots", () => {
    const router = new RemoteTerminalOutputRouter(6);
    router.observe({
      sessionId: "remote-1",
      offset: 0,
      base64: payload("abcdefghij"),
    });
    router.completeHydration([]);

    const received: Uint8Array[] = [];
    router.onData("remote-1", (bytes) => received.push(bytes));
    expect(joined(received)).toBe("efghij");
  });

  it("isolates pending tails and cursors between sessions", () => {
    const router = new RemoteTerminalOutputRouter();
    router.completeHydration([]);
    router.observe({
      sessionId: "remote-a",
      offset: 0,
      base64: payload("alpha"),
    });
    router.observe({
      sessionId: "remote-b",
      offset: 0,
      base64: payload("beta"),
    });

    const alpha: Uint8Array[] = [];
    const beta: Uint8Array[] = [];
    router.onData("remote-a", (bytes) => alpha.push(bytes));
    expect(joined(alpha)).toBe("alpha");
    expect(beta).toHaveLength(0);
    router.onData("remote-b", (bytes) => beta.push(bytes));
    expect(joined(beta)).toBe("beta");
  });

  it("drops duplicates after hydration and trims partial live overlap", () => {
    const router = new RemoteTerminalOutputRouter();
    router.completeHydration([]);
    const received: Uint8Array[] = [];
    router.onData("remote-1", (bytes) => received.push(bytes));

    router.observe({
      sessionId: "remote-1",
      offset: 0,
      base64: payload("abcd"),
    });
    router.observe({
      sessionId: "remote-1",
      offset: 0,
      base64: payload("abcd"),
    });
    router.observe({
      sessionId: "remote-1",
      offset: 2,
      base64: payload("cdef"),
    });

    expect(joined(received)).toBe("abcdef");
  });

  it("clears pending data and cursor on close and ignores late output", () => {
    const router = new RemoteTerminalOutputRouter();
    router.completeHydration([]);
    router.observe({
      sessionId: "remote-1",
      offset: 0,
      base64: payload("stale"),
    });
    router.close("remote-1");

    const received: Uint8Array[] = [];
    router.onData("remote-1", (bytes) => received.push(bytes));
    expect(received).toHaveLength(0);
    expect(
      router.observe({
        sessionId: "remote-1",
        offset: 5,
        base64: payload("late"),
      }),
    ).toBe(false);

    router.open("remote-1");
    router.observe({
      sessionId: "remote-1",
      offset: 0,
      base64: payload("fresh"),
    });
    expect(joined(received)).toBe("fresh");
  });

  it("does not replay a hydration snapshot for an already closed session", () => {
    const router = new RemoteTerminalOutputRouter();
    router.observe({
      sessionId: "remote-closed",
      offset: 0,
      base64: payload("live"),
    });
    router.close("remote-closed");
    router.completeHydration([
      {
        sessionId: "remote-closed",
        startOffset: 0,
        endOffset: 8,
        base64: payload("snapshot"),
      },
    ]);

    const received: Uint8Array[] = [];
    router.onData("remote-closed", (bytes) => received.push(bytes));
    expect(received).toHaveLength(0);
  });

  it("keeps valid live output when a malformed snapshot is ignored", () => {
    const router = new RemoteTerminalOutputRouter();
    router.observe({
      sessionId: "remote-1",
      offset: 0,
      base64: payload("live"),
    });
    router.completeHydration([
      {
        sessionId: "remote-1",
        startOffset: 0,
        endOffset: 99,
        base64: payload("bad"),
      },
    ]);

    const received: Uint8Array[] = [];
    router.onData("remote-1", (bytes) => received.push(bytes));
    expect(joined(received)).toBe("live");
    expect(
      router.observe({ sessionId: "remote-1", offset: 4, base64: "!!!!" }),
    ).toBe(false);
  });
});

describe("Lattice Remote event readiness", () => {
  it("waits until the active listener generation is ready", async () => {
    const gate = new RemoteEventReadinessGate();
    const attempt = gate.begin();
    let settled = false;
    const waiting = gate.wait().then((ready) => {
      settled = true;
      return ready;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    attempt.ready();
    await expect(waiting).resolves.toBe(true);
  });

  it("fails safely when listener subscription cannot complete", async () => {
    const gate = new RemoteEventReadinessGate();
    const attempt = gate.begin();
    const waiting = gate.wait();
    attempt.fail();

    await expect(waiting).resolves.toBe(false);
    await expect(gate.wait()).resolves.toBe(false);
  });

  it("follows a replacement generation across StrictMode cleanup", async () => {
    const gate = new RemoteEventReadinessGate();
    const first = gate.begin();
    const waiting = gate.wait();
    first.fail();
    const replacement = gate.begin();
    replacement.ready();

    await expect(waiting).resolves.toBe(true);
  });

  it("does not let stale cleanup fail the replacement generation", async () => {
    const gate = new RemoteEventReadinessGate();
    const stale = gate.begin();
    const replacement = gate.begin();
    stale.fail();
    replacement.ready();

    await expect(gate.wait()).resolves.toBe(true);
  });

  it("invalidates a previously ready generation during cleanup", async () => {
    const gate = new RemoteEventReadinessGate();
    const attempt = gate.begin();
    attempt.ready();
    await expect(gate.wait()).resolves.toBe(true);

    attempt.fail();
    await expect(gate.wait()).resolves.toBe(false);
  });
});

describe("Lattice Remote connect races", () => {
  it("turns a connected response into a failure when close arrived first", () => {
    const guard = new RemoteConnectRaceGuard();
    const attempt = guard.begin();
    guard.observeClosed("remote-fast", "Agent exited");

    expect(
      settleRemoteConnectOutcome(connectedOutcome, attempt.finish()),
    ).toEqual({
      outcome: "failed",
      stage: "startup",
      detail: "Build host closed during startup: Agent exited",
    });
  });

  it("isolates concurrent attempts and clears tombstones after settlement", () => {
    const guard = new RemoteConnectRaceGuard();
    const first = guard.begin();
    const second = guard.begin();
    guard.observeClosed("remote-fast", "Agent exited");

    const unrelated = {
      ...connectedOutcome,
      sessionId: "remote-running",
    };
    expect(settleRemoteConnectOutcome(unrelated, second.finish())).toBe(
      unrelated,
    );
    expect(
      settleRemoteConnectOutcome(connectedOutcome, first.finish()).outcome,
    ).toBe("failed");

    const later = guard.begin();
    expect(settleRemoteConnectOutcome(connectedOutcome, later.finish())).toBe(
      connectedOutcome,
    );
  });
});

describe("Lattice Remote automatic reconnect", () => {
  const relayRequest = {
    profileId: "mac",
    hostname: "",
    port: 0,
    pairingCode: "secret-code",
    rememberPairingCode: true,
    deviceId: "008806370",
    relayAddress: "relay.example",
  };

  it("only retries relay connections whose code is saved, never keeping the secret", () => {
    expect(remoteReconnectRequest(relayRequest)).toEqual({
      ...relayRequest,
      pairingCode: "",
      useSavedPairingCode: true,
      rememberPairingCode: false,
      legacyPairing: false,
    });
    expect(
      remoteReconnectRequest({ ...relayRequest, rememberPairingCode: false }),
    ).toBeNull();
    expect(
      remoteReconnectRequest({ ...relayRequest, deviceId: undefined }),
    ).toBeNull();
  });

  it("keeps trying through transient failures and stops on a pairing refusal", async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => { sleeps.push(ms); };
    const failed = (stage: string): RemoteConnectOutcome => ({
      outcome: "failed", stage, detail: "",
    });
    const flaky = [failed("connect"), failed("connect"), connectedOutcome];
    const outcome = await runRemoteReconnect({
      request: relayRequest,
      connect: async () => flaky.shift()!,
      sleep,
      stillWanted: () => true,
      delays: [1, 2, 3, 4],
    });
    expect(outcome).toBe(connectedOutcome);
    expect(sleeps).toEqual([1, 2, 3]);

    let attempts = 0;
    const refused = await runRemoteReconnect({
      request: relayRequest,
      connect: async () => { attempts += 1; return failed("pairing"); },
      sleep,
      stillWanted: () => true,
      delays: [1, 2, 3],
    });
    expect(refused).toEqual(failed("pairing"));
    expect(attempts).toBe(1);
  });

  it("stops without connecting once the person reconnected by hand", async () => {
    let attempts = 0;
    const outcome = await runRemoteReconnect({
      request: relayRequest,
      connect: async () => { attempts += 1; return connectedOutcome; },
      sleep: async () => {},
      stillWanted: () => false,
    });
    expect(outcome).toBeNull();
    expect(attempts).toBe(0);
  });
});
