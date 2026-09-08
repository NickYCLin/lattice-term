import { describe, expect, it } from "vitest";
import { AppLifecycleGuard } from "./appLifecycleGuard";

describe("application lifecycle exclusion", () => {
  it.each(["editor", "update"] as const)("gives the first %s operation exclusive ownership synchronously", (owner) => {
    const guard = new AppLifecycleGuard();
    const lease = guard.acquire(owner);
    expect(lease).not.toBeNull();
    expect(guard.owner).toBe(owner);
    expect(guard.acquire("editor")).toBeNull();
    expect(guard.acquire("update")).toBeNull();
    lease!.release();
    expect(guard.owner).toBeNull();
  });

  it("does not let a repeated release revoke a newer operation", () => {
    const guard = new AppLifecycleGuard();
    const old = guard.acquire("editor")!;
    old.release();
    const current = guard.acquire("update")!;
    old.release();
    expect(guard.owner).toBe("update");
    expect(guard.acquire("editor")).toBeNull();
    current.release();
    expect(guard.owner).toBeNull();
  });
});
