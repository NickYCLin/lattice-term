import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { useSessionClose } from "./useSessionClose";

it("reports a failed close and allows retry without an unhandled rejection", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let api!: ReturnType<typeof useSessionClose>;
  function Probe() { api = useSessionClose(); return null; }
  const action = vi.fn().mockRejectedValueOnce(new Error("disconnect refused")).mockResolvedValue(undefined);
  try {
    await act(async () => root.render(<Probe />));
    await act(async () => api.run("ssh-1", action));
    expect(api.error).toBe("disconnect refused");
    expect(api.pending.size).toBe(0);
    await act(async () => api.run("ssh-1", action));
    expect(action).toHaveBeenCalledTimes(2);
    expect(api.error).toBeNull();
  } finally { await act(async () => root.unmount()); }
});

it("ignores repeated clicks before React rerenders and permits other sessions", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let api!: ReturnType<typeof useSessionClose>;
  function Probe() { api = useSessionClose(); return null; }
  let finish!: () => void;
  const action = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const otherAction = vi.fn().mockResolvedValue(undefined);
  try {
    await act(async () => root.render(<Probe />));
    let closing!: Promise<void>;
    await act(async () => {
      closing = api.run("ssh-1", action);
      await api.run("ssh-1", action);
      await api.run("agent-1", otherAction);
    });
    expect(action).toHaveBeenCalledTimes(1);
    expect(otherAction).toHaveBeenCalledTimes(1);
    expect(api.pending.has("ssh-1")).toBe(true);
    await act(async () => { finish(); await closing; });
    expect(api.pending.size).toBe(0);
  } finally { await act(async () => root.unmount()); }
});
