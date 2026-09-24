import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { useCliUpdates, type CliUpdate } from "./useCliUpdates";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

it("honors startup settings, deduplicates checks and lets users dismiss failures", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let api!: ReturnType<typeof useCliUpdates>;
  function Probe({ enabled }: { enabled: boolean }) {
    api = useCliUpdates(enabled);
    return null;
  }
  let finish!: (items: CliUpdate[]) => void;
  invoke.mockImplementation(() => new Promise<CliUpdate[]>(resolve => { finish = resolve; }));
  try {
    await act(async () => { root.render(<StrictMode><Probe enabled={false} /></StrictMode>); });
    expect(invoke).not.toHaveBeenCalled();
    await act(async () => { root.render(<StrictMode><Probe enabled /></StrictMode>); });
    await act(async () => { void api.check(); });
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(async () => { finish([{ id: "cursor", label: "Cursor", currentVersion: null, latestVersion: null, status: "manual", sourceUrl: "https://cursor.com/docs" }]); });
    expect(api.visible).toBe(false);
    invoke.mockRejectedValueOnce(new Error("offline"));
    await act(async () => { await api.check(); });
    expect(api.error).toBe(true);
    expect(api.visible).toBe(true);
    await act(async () => { api.dismiss(); });
    expect(api.visible).toBe(false);
  } finally {
    await act(async () => { root.unmount(); });
    vi.clearAllMocks();
  }
});

it("supports updating individual CLIs and update-all", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let api!: ReturnType<typeof useCliUpdates>;
  function Probe() {
    api = useCliUpdates(false);
    return null;
  }
  try {
    await act(async () => { root.render(<StrictMode><Probe /></StrictMode>); });
    invoke.mockResolvedValueOnce("ok").mockResolvedValueOnce([
      { id: "codex", label: "Codex", currentVersion: "0.101.0", latestVersion: "0.101.0", status: "current", sourceUrl: "", updatable: true },
    ]);
    let success = false;
    await act(async () => {
      success = await api.updateCli("codex");
    });
    expect(success).toBe(true);
    expect(invoke).toHaveBeenCalledWith("agent_update_cli", { id: "codex" });
  } finally {
    await act(async () => { root.unmount(); });
    vi.clearAllMocks();
  }
});
