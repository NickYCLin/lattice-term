import { describe, expect, it } from "vitest";
import { createSerialQueue } from "./serialQueue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("createSerialQueue", () => {
  it("never runs two tasks at once and keeps their order", async () => {
    const run = createSerialQueue();
    const first = deferred<string>();
    const started: string[] = [];
    let running = 0;
    let peak = 0;
    const task = (name: string, wait: Promise<string>) => async () => {
      started.push(name);
      running += 1;
      peak = Math.max(peak, running);
      try { return await wait; } finally { running -= 1; }
    };
    const a = run(task("a", first.promise));
    const b = run(task("b", Promise.resolve("b")));
    await Promise.resolve();
    expect(started).toEqual(["a"]);
    first.resolve("a");
    await expect(a).resolves.toBe("a");
    await expect(b).resolves.toBe("b");
    expect(started).toEqual(["a", "b"]);
    expect(peak).toBe(1);
  });

  it("keeps going after a failed task", async () => {
    const run = createSerialQueue();
    const failed = run(async () => { throw new Error("listing failed"); });
    const next = run(async () => "next");
    await expect(failed).rejects.toThrow("listing failed");
    await expect(next).resolves.toBe("next");
  });
});
