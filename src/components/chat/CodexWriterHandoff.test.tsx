import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { HostNode, allNodes, installHostDom, props } from "../agents/testFixtures/interactionDom";
import { CodexWriterHandoff } from "./CodexWriterHandoff";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../../app/nativeRuntime", () => ({ hasDesktopBackend: () => true }));
let host: HostNode, root: ReturnType<typeof createRoot>, timers: (() => void)[];
beforeEach(() => {
  host = installHostDom(); root = createRoot(host as unknown as Element); timers = [];
  window.setInterval = ((fn: () => void) => { timers.push(fn); return timers.length; }) as typeof window.setInterval;
  window.clearInterval = () => {};
  invoke.mockReset().mockResolvedValue({ holder: { kind: "codex_desktop", pid: 4321 }, available: false });
});
afterEach(async () => { await act(async () => root.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const click = async (label: string) => { const node = allNodes(host).find(n => n.tagName === "BUTTON" && n.textContent.includes(label))!; await act(async () => props(node).onClick()); };
async function mount(retry = vi.fn(async () => {})) {
  await act(async () => root.render(<I18nProvider locale="zh-TW"><CodexWriterHandoff nativeId="aa-bb" onRetry={retry} /></I18nProvider>)); return retry;
}
it("identifies the holder and waits for availability before exactly one retry", async () => {
  const retry = await mount(); expect(host.textContent).toContain("Codex Desktop · PID 4321");
  expect(retry).not.toHaveBeenCalled(); await click("接手"); expect(host.textContent).toContain("正在等待");
  invoke.mockResolvedValue({ holder: null, available: true });
  await act(async () => timers[timers.length - 1]());
  expect(retry).toHaveBeenCalledTimes(1);
  await act(async () => timers[timers.length - 1]()); expect(retry).toHaveBeenCalledTimes(1);
});
it("cancels without retrying and stops after a bounded timeout", async () => {
  const retry = await mount(); await click("接手"); await click("取消");
  await act(async () => timers[timers.length - 1]()); expect(retry).not.toHaveBeenCalled();
  let now = 1000; vi.spyOn(Date, "now").mockImplementation(() => now);
  await click("接手"); now += 120001;
  await act(async () => timers[timers.length - 1]());
  expect(host.textContent).toContain("等待已逾時"); expect(retry).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain("結束占用方");
});
