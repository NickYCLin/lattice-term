import { describe, expect, it } from "vitest";
import {
  createSensitiveClipboardController,
  sensitiveClipboardClearDelayMs,
} from "./sensitiveClipboard";

function fixture({ readFails = false } = {}) {
  let clipboard = "";
  let nextTimer = 1;
  const timers = new Map<number, () => void>();
  const controller = createSensitiveClipboardController(
    {
      readText: async () => {
        if (readFails) throw new Error("clipboard read refused");
        return clipboard;
      },
      writeText: async (value) => {
        clipboard = value;
      },
    },
    {
      set: (callback) => {
        const handle = nextTimer;
        nextTimer += 1;
        timers.set(handle, callback);
        return handle;
      },
      clear: (handle) => {
        timers.delete(handle);
      },
    },
    async (value) => new TextEncoder().encode(value),
  );

  return {
    controller,
    clipboard: () => clipboard,
    replaceClipboard: (value: string) => {
      clipboard = value;
    },
    timerHandles: () => [...timers.keys()],
    async runTimer(handle: number) {
      const callback = timers.get(handle);
      timers.delete(handle);
      callback?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe("sensitiveClipboardClearDelayMs", () => {
  it("maps the preference to a delay", () => {
    expect(sensitiveClipboardClearDelayMs("off")).toBeNull();
    expect(sensitiveClipboardClearDelayMs("15")).toBe(15_000);
    expect(sensitiveClipboardClearDelayMs("30")).toBe(30_000);
    expect(sensitiveClipboardClearDelayMs("60")).toBe(60_000);
    expect(sensitiveClipboardClearDelayMs("120")).toBe(120_000);
  });
});

describe("createSensitiveClipboardController", () => {
  it("keeps a newer secret tracked when an older read returns oversized content", async () => {
    let clipboard = "";
    let finishRead!: (value: string) => void;
    let reads = 0;
    let nextTimer = 0;
    const timers = new Map<number, () => void>();
    const controller = createSensitiveClipboardController({
      readText: () => ++reads === 1
        ? new Promise<string>((resolve) => { finishRead = resolve; })
        : Promise.resolve(clipboard),
      writeText: async (value) => { clipboard = value; },
    }, {
      set: (callback) => { timers.set(++nextTimer, callback); return nextTimer; },
      clear: (handle) => { timers.delete(handle); },
    }, async (value) => new TextEncoder().encode(value));
    try {
      await controller.copy("first-secret", 15_000);
      const clearing = controller.clear();
      await controller.copy("second-secret", 30_000);
      finishRead("x".repeat(4097));
      await expect(clearing).resolves.toBe("nothing");
      expect(timers.size).toBe(1);
      expect(clipboard).toBe("second-secret");
      await expect(controller.clear()).resolves.toBe("cleared");
      expect(clipboard).toBe("");
    } finally { controller.dispose(); }
  });

  it("clears the tracked value when its timer expires", async () => {
    const test = fixture();
    await test.controller.copy("48291357", 30_000);

    expect(test.clipboard()).toBe("48291357");
    const [timer] = test.timerHandles();
    await test.runTimer(timer);

    expect(test.clipboard()).toBe("");
    await expect(test.controller.clear()).resolves.toBe("nothing");
  });

  it("preserves a value copied later by the user", async () => {
    const test = fixture();
    await test.controller.copy("48291357", 30_000);
    test.replaceClipboard("a newer clipboard value");

    const [timer] = test.timerHandles();
    await test.runTimer(timer);

    expect(test.clipboard()).toBe("a newer clipboard value");
    await expect(test.controller.clear()).resolves.toBe("nothing");
  });

  it("cancels the older timer when another secret is copied", async () => {
    const test = fixture();
    await test.controller.copy("first", 15_000);
    const [firstTimer] = test.timerHandles();

    await test.controller.copy("second", 60_000);
    const [secondTimer] = test.timerHandles();

    expect(secondTimer).not.toBe(firstTimer);
    expect(test.timerHandles()).not.toContain(firstTimer);
    await test.runTimer(firstTimer);
    expect(test.clipboard()).toBe("second");

    await test.runTimer(secondTimer);
    expect(test.clipboard()).toBe("");
  });

  it("supports immediate clearing without enabling a timer", async () => {
    const test = fixture();
    await test.controller.copy("48291357", null);

    expect(test.timerHandles()).toEqual([]);
    await expect(test.controller.clear()).resolves.toBe("cleared");
    expect(test.clipboard()).toBe("");
  });

  it("does not clear unrelated clipboard content on demand", async () => {
    const test = fixture();
    await test.controller.copy("48291357", null);
    test.replaceClipboard("keep this");

    await expect(test.controller.clear()).resolves.toBe("preserved");
    expect(test.clipboard()).toBe("keep this");
  });

  it("reports an unavailable clipboard without destroying its tracking", async () => {
    const test = fixture({ readFails: true });
    await test.controller.copy("48291357", null);

    await expect(test.controller.clear()).resolves.toBe("unavailable");
    expect(test.clipboard()).toBe("48291357");
  });

  it("rejects empty or oversized sensitive values before copying", async () => {
    const test = fixture();

    await expect(test.controller.copy("", null)).rejects.toThrow(
      "empty or exceeds",
    );
    await expect(
      test.controller.copy("x".repeat(4 * 1024 + 1), null),
    ).rejects.toThrow("empty or exceeds");
    expect(test.clipboard()).toBe("");
  });
});
