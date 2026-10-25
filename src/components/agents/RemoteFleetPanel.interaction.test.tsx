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

async function mount() {
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  await act(async () => root.render(<I18nProvider locale="zh-TW"><RemoteFleetPanel /></I18nProvider>));
  return { host, unmount: async () => { await act(async () => root.unmount()); } };
}

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
