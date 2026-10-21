import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { useCliUpdates, type CliUpdate } from "./useCliUpdates";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

it("tracks batch activity, failures and verification without overlapping updates", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let api!: ReturnType<typeof useCliUpdates>;
  function Probe() {
    api = useCliUpdates(false);
    return null;
  }
  const items: CliUpdate[] = ["codex", "claude"].map(id => ({
    id, label: id, currentVersion: "1.0.0", latestVersion: "1.1.0",
    status: "available", sourceUrl: "", updatable: true,
  }));
  let failFirst!: (reason: Error) => void;
  let finishSecond!: (value: string) => void;
  let finishCheck!: (value: CliUpdate[]) => void;
  try {
    await act(async () => { root.render(<Probe />); });
    invoke.mockResolvedValueOnce(items);
    await act(async () => { await api.check(); });
    invoke
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { failFirst = reject; }))
      .mockImplementationOnce(() => new Promise(resolve => { finishSecond = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { finishCheck = resolve; }));
    let pending!: Promise<void>;
    await act(async () => {
      pending = api.updateAll();
      expect(await api.updateCli("codex")).toBe(false);
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(api.progress).toMatchObject({ activeId: "codex", completed: 0, total: 2, phase: "updating" });
    await act(async () => { failFirst(new Error("offline")); });
    expect(api.progress).toMatchObject({ activeId: "claude", completed: 1, total: 2, phase: "updating" });
    await act(async () => { finishSecond("ok"); });
    expect(api.progress).toMatchObject({ activeId: null, completed: 2, total: 2, phase: "checking" });
    await act(async () => { finishCheck(items); await pending; });
    expect(api.progress).toBeNull();
    expect(api.updating).toBeNull();
    expect(api.updateError).toContain("codex: offline");
  } finally {
    await act(async () => { root.unmount(); });
    vi.clearAllMocks();
  }
});

it("shows single-item activity then verification and clears progress on failure", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let api!: ReturnType<typeof useCliUpdates>;
  function Probe() {
    api = useCliUpdates(false);
    return null;
  }
  let finishUpdate!: (value: string) => void;
  let finishCheck!: (value: CliUpdate[]) => void;
  try {
    await act(async () => { root.render(<Probe />); });
    invoke
      .mockImplementationOnce(() => new Promise(resolve => { finishUpdate = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { finishCheck = resolve; }));
    let pending!: Promise<boolean>;
    await act(async () => { pending = api.updateCli("codex"); });
    expect(api.progress).toMatchObject({ activeId: "codex", total: 1, phase: "updating" });
    await act(async () => { finishUpdate("ok"); });
    expect(api.progress?.phase).toBe("checking");
    await act(async () => { finishCheck([]); await pending; });
    expect(api.progress).toBeNull();
    invoke.mockRejectedValueOnce(new Error("timeout"));
    await act(async () => { expect(await api.updateCli("codex")).toBe(false); });
    expect(api.progress).toBeNull();
    expect(api.updateError).toBe("timeout");
  } finally {
    await act(async () => { root.unmount(); });
    vi.clearAllMocks();
  }
});

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

it("waits for a fresh verification when an older version check overlaps an update", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let api!: ReturnType<typeof useCliUpdates>;
  function Probe() { api = useCliUpdates(false); return null; }
  let finishOldCheck!: (items: CliUpdate[]) => void;
  let finishVerification!: (items: CliUpdate[]) => void;
  const stale: CliUpdate[] = [{ id: "codex", label: "Codex", currentVersion: "1.0.0", latestVersion: "2.0.0", status: "available", sourceUrl: "" }];
  try {
    await act(async () => root.render(<Probe />));
    invoke.mockImplementationOnce(() => new Promise(resolve => { finishOldCheck = resolve; }))
      .mockResolvedValueOnce("ok")
      .mockImplementationOnce(() => new Promise(resolve => { finishVerification = resolve; }));
    let check!: Promise<CliUpdate[] | null>;
    let update!: Promise<boolean>;
    let completed = false;
    await act(async () => {
      check = api.check();
      update = api.updateCli("codex").then(success => { completed = true; return success; });
    });
    expect(completed).toBe(false);
    expect(api.progress?.phase).toBe("checking");
    await act(async () => { finishOldCheck(stale); await check; });
    expect(invoke.mock.calls.filter(([command]) => command === "agent_check_updates")).toHaveLength(2);
    expect(completed).toBe(false);
    await act(async () => { finishVerification([]); expect(await update).toBe(true); });
    expect(api.items).toEqual([]);
    expect(api.progress).toBeNull();
    expect(api.visible).toBe(false);
  } finally {
    await act(async () => root.unmount());
    vi.clearAllMocks();
  }
});

it("waits for the older check before verifying a batch update", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let api!: ReturnType<typeof useCliUpdates>;
  function Probe() { api = useCliUpdates(false); return null; }
  const stale: CliUpdate[] = [{ id: "codex", label: "Codex", currentVersion: "1.0.0", latestVersion: "2.0.0", status: "available", sourceUrl: "", updatable: true }];
  let finishOldCheck!: (items: CliUpdate[]) => void;
  let finishVerification!: (items: CliUpdate[]) => void;
  try {
    await act(async () => root.render(<Probe />));
    invoke.mockResolvedValueOnce(stale);
    await act(async () => { await api.check(); });
    invoke.mockImplementationOnce(() => new Promise(resolve => { finishOldCheck = resolve; }))
      .mockResolvedValueOnce("ok")
      .mockImplementationOnce(() => new Promise(resolve => { finishVerification = resolve; }));
    let oldCheck!: Promise<CliUpdate[] | null>;
    let update!: Promise<void>;
    let completed = false;
    await act(async () => {
      oldCheck = api.check();
      update = api.updateAll().then(() => { completed = true; });
    });
    expect(completed).toBe(false);
    expect(api.progress?.phase).toBe("checking");
    await act(async () => { finishOldCheck(stale); await oldCheck; });
    expect(invoke.mock.calls.filter(([command]) => command === "agent_check_updates")).toHaveLength(3);
    expect(completed).toBe(false);
    await act(async () => { finishVerification([]); await update; });
    expect(api.items).toEqual([]);
    expect(api.visible).toBe(false);
    expect(api.progress).toBeNull();
  } finally {
    await act(async () => root.unmount());
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

it("closes the card once every CLI is updated", async () => {
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
    expect(api.visible).toBe(true);
    invoke.mockResolvedValueOnce("ok").mockResolvedValueOnce([
      { id: "codex", label: "Codex", currentVersion: "1.1.0", latestVersion: "1.1.0", status: "current", sourceUrl: "", updatable: true },
    ]);
    await act(async () => { await api.updateCli("codex"); });
    expect(api.updated).toEqual(["Codex"]);
    expect(api.visible).toBe(false);
  } finally {
    await act(async () => { root.unmount(); });
    vi.clearAllMocks();
  }
});

it("stays open while another CLI still has an update", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let api!: ReturnType<typeof useCliUpdates>;
  function Probe() {
    api = useCliUpdates(false);
    return null;
  }
  const item = (id: string, label: string, status: CliUpdate["status"]): CliUpdate => ({
    id, label, currentVersion: "1.0.0", latestVersion: "1.1.0", status, sourceUrl: "", updatable: true,
  });
  try {
    await act(async () => { root.render(<Probe />); });
    invoke.mockResolvedValueOnce([item("codex", "Codex", "available"), item("claude", "Claude Code", "available")]);
    await act(async () => { await api.check(); });
    invoke.mockResolvedValueOnce("ok").mockResolvedValueOnce([item("codex", "Codex", "current"), item("claude", "Claude Code", "available")]);
    await act(async () => { await api.updateCli("codex"); });
    expect(api.visible).toBe(true);
    invoke.mockResolvedValueOnce("ok").mockResolvedValueOnce([item("codex", "Codex", "current"), item("claude", "Claude Code", "current")]);
    await act(async () => { await api.updateAll(); });
    expect(api.updated).toEqual(["Codex", "Claude Code"]);
    expect(api.visible).toBe(false);
  } finally {
    await act(async () => { root.unmount(); });
    vi.clearAllMocks();
  }
});
