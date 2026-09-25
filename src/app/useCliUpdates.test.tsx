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

it("keeps updating the rest when one CLI fails and reports what changed", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let api!: ReturnType<typeof useCliUpdates>;
  function Probe() {
    api = useCliUpdates(false);
    return null;
  }
  const available = (id: string, label: string): CliUpdate => ({
    id, label, currentVersion: "1.0.0", latestVersion: "1.1.0", status: "available", sourceUrl: "", updatable: true,
  });
  try {
    await act(async () => { root.render(<Probe />); });
    invoke.mockResolvedValueOnce([available("codex", "Codex"), available("claude", "Claude Code")]);
    await act(async () => { await api.check(); });
    invoke
      .mockRejectedValueOnce("更新失敗: EACCES")
      .mockResolvedValueOnce("ok")
      .mockResolvedValueOnce([
        available("codex", "Codex"),
        { ...available("claude", "Claude Code"), currentVersion: "1.1.0", status: "current" },
      ]);
    await act(async () => { await api.updateAll(); });
    expect(invoke).toHaveBeenCalledWith("agent_update_cli", { id: "claude" });
    expect(api.updateError).toBe("Codex: 更新失敗: EACCES");
    expect(api.updated).toEqual(["Claude Code"]);
    expect(api.items.find(item => item.id === "claude")?.status).toBe("current");
    expect(api.visible).toBe(true);
  } finally {
    await act(async () => { root.unmount(); });
    vi.clearAllMocks();
  }
});

it("stays open after everything is updated so the result is visible", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let api!: ReturnType<typeof useCliUpdates>;
  function Probe() {
    api = useCliUpdates(false);
    return null;
  }
  try {
    await act(async () => { root.render(<Probe />); });
    invoke.mockResolvedValueOnce([
      { id: "codex", label: "Codex", currentVersion: "1.0.0", latestVersion: "1.1.0", status: "available", sourceUrl: "", updatable: true },
    ]);
    await act(async () => { await api.check(); });
    invoke.mockResolvedValueOnce("ok").mockResolvedValueOnce([
      { id: "codex", label: "Codex", currentVersion: "1.1.0", latestVersion: "1.1.0", status: "current", sourceUrl: "", updatable: true },
    ]);
    await act(async () => { await api.updateCli("codex"); });
    expect(api.updated).toEqual(["Codex"]);
    expect(api.visible).toBe(true);
    await act(async () => { api.dismiss(); });
    expect(api.visible).toBe(false);
  } finally {
    await act(async () => { root.unmount(); });
    vi.clearAllMocks();
  }
});
