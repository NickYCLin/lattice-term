/**
 * Sensitive clipboard policy.
 *
 * The controller remembers only a SHA-256 digest of the last value copied by
 * LatticeTerm. Before clearing, it reads and compares the current clipboard so
 * a value copied later by the user is preserved.
 */

export type SensitiveClipboardClearChoice =
  | "off"
  | "15"
  | "30"
  | "60"
  | "120";

export type SensitiveClipboardClearOutcome =
  | "cleared"
  | "nothing"
  | "preserved"
  | "unavailable";

interface ClipboardAdapter {
  readText: () => Promise<string>;
  writeText: (value: string) => Promise<void>;
}

interface Scheduler {
  set: (callback: () => void, delayMs: number) => number;
  clear: (handle: number) => void;
}

interface TrackedClipboardValue {
  generation: number;
  digest: Uint8Array;
  timer: number | null;
}

const MAX_SENSITIVE_VALUE_BYTES = 4 * 1024;

export function sensitiveClipboardClearDelayMs(
  choice: SensitiveClipboardClearChoice,
): number | null {
  if (choice === "off") return null;
  return Number(choice) * 1_000;
}

async function sha256(value: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(value);
  try {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  } finally {
    bytes.fill(0);
  }
}

function sameDigest(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export function createSensitiveClipboardController(
  adapter: ClipboardAdapter,
  scheduler: Scheduler,
  digestText: (value: string) => Promise<Uint8Array> = sha256,
) {
  let generation = 0;
  let tracked: TrackedClipboardValue | null = null;

  function forgetTracked() {
    if (tracked?.timer !== null && tracked?.timer !== undefined) {
      scheduler.clear(tracked.timer);
    }
    tracked = null;
  }

  async function clearGeneration(
    expectedGeneration: number,
  ): Promise<SensitiveClipboardClearOutcome> {
    const candidate = tracked;
    if (!candidate || candidate.generation !== expectedGeneration) {
      return "nothing";
    }

    try {
      const current = await adapter.readText();
      if (tracked?.generation !== expectedGeneration) return "nothing";
      if (current.length > MAX_SENSITIVE_VALUE_BYTES) {
        forgetTracked();
        return "preserved";
      }
      const currentDigest = await digestText(current);
      if (tracked?.generation !== expectedGeneration) return "nothing";
      if (!sameDigest(candidate.digest, currentDigest)) {
        forgetTracked();
        return "preserved";
      }

      await adapter.writeText("");
      if (tracked?.generation === expectedGeneration) forgetTracked();
      return "cleared";
    } catch {
      return "unavailable";
    }
  }

  return {
    async copy(value: string, delayMs: number | null): Promise<void> {
      const size = new TextEncoder().encode(value).length;
      if (size === 0 || size > MAX_SENSITIVE_VALUE_BYTES) {
        throw new Error(
          "Sensitive clipboard text is empty or exceeds the safe size limit.",
        );
      }

      generation += 1;
      const currentGeneration = generation;
      forgetTracked();

      const digest = await digestText(value);
      if (currentGeneration !== generation) return;

      await adapter.writeText(value);
      if (currentGeneration !== generation) return;

      tracked = {
        generation: currentGeneration,
        digest,
        timer: null,
      };
      if (delayMs !== null) {
        tracked.timer = scheduler.set(() => {
          void clearGeneration(currentGeneration);
        }, delayMs);
      }
    },

    async clear(): Promise<SensitiveClipboardClearOutcome> {
      if (!tracked) return "nothing";
      return clearGeneration(tracked.generation);
    },

    dispose() {
      generation += 1;
      forgetTracked();
    },
  };
}

function browserClipboard(): ClipboardAdapter {
  if (!navigator.clipboard) {
    throw new Error("The system clipboard is not available in this runtime.");
  }
  return {
    readText: () => navigator.clipboard.readText(),
    writeText: (value) => navigator.clipboard.writeText(value),
  };
}

const controller = createSensitiveClipboardController(
  {
    readText: () => browserClipboard().readText(),
    writeText: (value) => browserClipboard().writeText(value),
  },
  {
    set: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clear: (handle) => window.clearTimeout(handle),
  },
);

export function copySensitiveText(
  value: string,
  choice: SensitiveClipboardClearChoice,
): Promise<void> {
  const delayMs = sensitiveClipboardClearDelayMs(choice);
  if (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window
  ) {
    return import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke("sensitive_clipboard_copy", {
        value,
        clearAfterSeconds: delayMs === null ? null : delayMs / 1_000,
      }),
    );
  }
  return controller.copy(value, delayMs);
}

export async function clearSensitiveClipboard(): Promise<SensitiveClipboardClearOutcome> {
  if (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window
  ) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<SensitiveClipboardClearOutcome>(
        "sensitive_clipboard_clear",
      );
    } catch {
      return "unavailable";
    }
  }
  return controller.clear();
}
