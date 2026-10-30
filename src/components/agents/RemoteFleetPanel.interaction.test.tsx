import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import * as fleet from "../../app/remoteFleet";
import type { FleetSession, FleetTarget } from "../../app/remoteFleet";
import { RemoteFleetPanel } from "./RemoteFleetPanel";
import { allNodes, installHostDom, props, type HostNode } from "./testFixtures/interactionDom";

vi.mock("../../app/nativeRuntime", () => ({ hasDesktopBackend: () => true }));
vi.mock("../../app/remoteFleet", async (original) => ({
  ...await original<typeof fleet>(),
  listFleetTargets: vi.fn(), listFleetSessions: vi.fn(), listFleetPlans: vi.fn(),
  readFleetOutput: vi.fn(), launchFleetPlan: vi.fn(), sendFleetPrompt: vi.fn(), cancelFleetTurn: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const targets: FleetTarget[] = ["alpha", "beta"].map(id => ({
  id, label: id, backend: "relay", connected: true,
  scopes: { fleetObserve: true, fleetRead: true, fleetControl: true, fleetLaunch: true },
}));
const session = (label: string, readOutput = true): FleetSession => ({
  sessionId: "shared-session-id", label, definitionId: "codex", state: "idle", access: "control", readOutput,
});
const button = (host: HostNode, text: string) => allNodes(host).find(node => node.tagName === "BUTTON" && node.textContent.includes(text))!;
const selectTarget = async (host: HostNode, id: string) => {
  await act(async () => props(allNodes(host).find(node => node.tagName === "SELECT")!).onChange({ target: { value: id } }));
};

beforeEach(() => {
  vi.mocked(fleet.listFleetTargets).mockResolvedValue(targets);
  vi.mocked(fleet.listFleetSessions).mockResolvedValue([]);
  vi.mocked(fleet.listFleetPlans).mockResolvedValue([]);
  vi.mocked(fleet.readFleetOutput).mockResolvedValue({ text: "", nextCursor: 0, hasMore: false });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetAllMocks(); });

async function mount(mobile = false) {
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  await act(async () => root.render(<I18nProvider locale="zh-TW"><RemoteFleetPanel mobile={mobile} /></I18nProvider>));
  return { host, unmount: async () => { await act(async () => root.unmount()); } };
}

it("shows only connected Lattice Remote Fleet targets on mobile", async () => {
  vi.mocked(fleet.listFleetTargets).mockResolvedValue([
    { ...targets[0], backend: "ssh" },
    { ...targets[1], backend: "remote" },
    { ...targets[0], id: "offline", label: "offline", backend: "remote", connected: false },
  ]);
  const { host, unmount } = await mount(true);
  try {
    expect(allNodes(host).filter(node => node.tagName === "OPTION").map(node => node.textContent)).toEqual(["beta"]);
    expect(fleet.listFleetSessions).toHaveBeenCalledWith("beta");
    expect(host.textContent).toContain("手機不執行本機 Agent");
  } finally { await unmount(); }
});

it("explains how to connect when no mobile Fleet host is available", async () => {
  vi.mocked(fleet.listFleetTargets).mockResolvedValue([{ ...targets[0], backend: "ssh" }]);
  const { host, unmount } = await mount(true);
  try {
    expect(host.textContent).toContain("請先在遠端主機啟用 Fleet 分享");
    expect(fleet.listFleetSessions).not.toHaveBeenCalled();
  } finally { await unmount(); }
});

it("ignores old host sessions and launch plans after switching hosts", async () => {
  const oldSessions = deferred<FleetSession[]>();
  const oldPlans = deferred<{ planId: string; label: string }[]>();
  vi.mocked(fleet.listFleetSessions).mockImplementation(async id => id === "alpha" ? oldSessions.promise : [session("Beta session")]);
  vi.mocked(fleet.listFleetPlans).mockImplementation(async id => id === "alpha" ? oldPlans.promise : [{ planId: "beta-plan", label: "Beta plan" }]);
  const { host, unmount } = await mount();
  try {
    await selectTarget(host, "beta");
    expect(host.textContent).toContain("Beta session");
    await act(async () => {
      oldSessions.resolve([session("Wrong alpha session")]);
      oldPlans.resolve([{ planId: "alpha-plan", label: "Wrong alpha plan" }]);
    });
    expect(host.textContent).toContain("Beta session");
    expect(host.textContent).toContain("Beta plan");
    expect(host.textContent).not.toContain("Wrong alpha");
  } finally { await unmount(); }
});

it("does not show an old host failure on the newly selected host", async () => {
  const old = deferred<FleetSession[]>();
  vi.mocked(fleet.listFleetSessions).mockImplementation(async id => id === "alpha" ? old.promise : [session("Beta session")]);
  const { host, unmount } = await mount();
  try {
    await selectTarget(host, "beta");
    await act(async () => old.reject(new Error("Alpha unavailable")));
    expect(host.textContent).not.toContain("Alpha unavailable");
  } finally { await unmount(); }
});

it("keeps the newest host refresh when an older request finishes last", async () => {
  const old = deferred<FleetTarget[]>();
  vi.mocked(fleet.listFleetTargets).mockReturnValueOnce(old.promise).mockResolvedValueOnce([targets[1]]);
  const { host, unmount } = await mount();
  try {
    await act(async () => props(button(host, "重新整理")).onClick());
    await act(async () => old.resolve([targets[0]]));
    expect(allNodes(host).filter(node => node.tagName === "OPTION").map(node => node.textContent)).toEqual(["beta"]);
  } finally { await unmount(); }
});

it("closes an output pane when its read permission is revoked", async () => {
  vi.mocked(fleet.listFleetTargets).mockResolvedValueOnce([targets[0]]).mockResolvedValueOnce([{ ...targets[0], scopes: { ...targets[0].scopes, fleetRead: false } }]);
  vi.mocked(fleet.listFleetSessions).mockResolvedValueOnce([session("Alpha session")]).mockResolvedValueOnce([session("Alpha session", false)]);
  const lateOutput = deferred<{ text: string; nextCursor: number; hasMore: boolean }>();
  vi.mocked(fleet.readFleetOutput).mockReturnValue(lateOutput.promise);
  const { host, unmount } = await mount();
  try {
    await act(async () => props(button(host, "並排顯示")).onClick());
    await act(async () => props(button(host, "重新整理")).onClick());
    await act(async () => lateOutput.resolve({ text: "Revoked output", nextCursor: 10, hasMore: false }));
    expect(allNodes(host).filter(node => node.tagName === "PRE").length).toBe(0);
    expect(host.textContent).not.toContain("Revoked output");
  } finally { await unmount(); }
});

it("keeps the latest session poll when an older poll finishes last", async () => {
  vi.useFakeTimers();
  const old = deferred<FleetSession[]>();
  vi.mocked(fleet.listFleetSessions).mockReturnValueOnce(old.promise).mockResolvedValue([session("Latest session")]);
  const { host, unmount } = await mount();
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    await act(async () => old.resolve([session("Stale session")]));
    expect(host.textContent).toContain("Latest session");
    expect(host.textContent).not.toContain("Stale session");
  } finally { await unmount(); }
});

it("shows a target discovery failure even when no targets were loaded", async () => {
  vi.mocked(fleet.listFleetTargets).mockRejectedValue(new Error("Target discovery unavailable"));
  const { host, unmount } = await mount();
  try {
    expect(host.textContent).toContain("Target discovery unavailable");
  } finally { await unmount(); }
});

it("starts a saved plan only once for a rapid double click and allows retry after failure", async () => {
  const pending = deferred<{ session: FleetSession | null; duplicate: boolean }>();
  vi.mocked(fleet.listFleetPlans).mockResolvedValue([{ planId: "plan", label: "Test plan" }]);
  vi.mocked(fleet.launchFleetPlan).mockReturnValueOnce(pending.promise).mockResolvedValue({ session: null, duplicate: false });
  const { host, unmount } = await mount();
  try {
    const launch = () => button(host, "Test plan");
    await act(async () => { props(launch()).onClick(); props(launch()).onClick(); });
    expect(fleet.launchFleetPlan).toHaveBeenCalledTimes(1);
    expect(props(launch()).disabled).toBe(true);
    await act(async () => pending.reject(new Error("Launch interrupted")));
    expect(host.textContent).toContain("Launch interrupted");
    await act(async () => props(launch()).onClick());
    expect(fleet.launchFleetPlan).toHaveBeenCalledTimes(2);
  } finally { await unmount(); }
});

it("does not show a failed launch from a host that was left and then selected again", async () => {
  const pending = deferred<{ session: FleetSession | null; duplicate: boolean }>();
  vi.mocked(fleet.listFleetPlans).mockResolvedValue([{ planId: "plan", label: "Test plan" }]);
  vi.mocked(fleet.launchFleetPlan).mockReturnValue(pending.promise);
  const { host, unmount } = await mount();
  try {
    await act(async () => props(button(host, "Test plan")).onClick());
    await selectTarget(host, "beta");
    await selectTarget(host, "alpha");
    await act(async () => pending.reject(new Error("Old launch failure")));
    expect(host.textContent).not.toContain("Old launch failure");
  } finally { await unmount(); }
});

it("sends a prompt once, blocks concurrent cancellation and preserves the draft on failure", async () => {
  const pending = deferred<Record<string, unknown>>();
  vi.mocked(fleet.listFleetSessions).mockResolvedValue([session("Alpha session")]);
  vi.mocked(fleet.sendFleetPrompt).mockReturnValueOnce(pending.promise).mockResolvedValue({});
  const { host, unmount } = await mount();
  try {
    await act(async () => props(button(host, "並排顯示")).onClick());
    const input = allNodes(host).find(node => node.tagName === "INPUT")!;
    await act(async () => props(input).onChange({ target: { value: "Test prompt" } }));
    const form = allNodes(host).find(node => node.tagName === "FORM")!;
    await act(async () => {
      props(form).onSubmit({ preventDefault() {} });
      props(form).onSubmit({ preventDefault() {} });
      props(button(host, "取消這一輪")).onClick();
    });
    expect(fleet.sendFleetPrompt).toHaveBeenCalledTimes(1);
    expect(fleet.cancelFleetTurn).not.toHaveBeenCalled();
    await act(async () => pending.reject(new Error("Send interrupted")));
    expect(props(input).value).toBe("Test prompt");
    await act(async () => props(form).onSubmit({ preventDefault() {} }));
    expect(fleet.sendFleetPrompt).toHaveBeenCalledTimes(2);
    expect(props(input).value).toBe("");
  } finally { await unmount(); }
});

it("deduplicates cancellation before React disables the button", async () => {
  const pending = deferred<Record<string, unknown>>();
  vi.mocked(fleet.listFleetSessions).mockResolvedValue([session("Alpha session")]);
  vi.mocked(fleet.cancelFleetTurn).mockReturnValue(pending.promise);
  const { host, unmount } = await mount();
  try {
    await act(async () => props(button(host, "並排顯示")).onClick());
    await act(async () => {
      props(button(host, "取消這一輪")).onClick();
      props(button(host, "取消這一輪")).onClick();
    });
    expect(fleet.cancelFleetTurn).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({}));
  } finally { await unmount(); }
});
