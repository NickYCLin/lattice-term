import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { allNodes, installHostDom, props, type HostNode } from "../agents/testFixtures/interactionDom";
import { I18nProvider } from "../../i18n";
import { CanvasCaptureControls } from "./CanvasCaptureControls";

let container: HostNode;
let root: ReturnType<typeof createRoot>;
const trackStop = vi.fn();
const stop = vi.fn();
let failConstruction = false;
let instance: FakeRecorder;
class FakeRecorder {
  static isTypeSupported = () => true;
  state = "inactive";
  mimeType = "video/webm";
  onstop?: () => void;
  constructor() {
    if (failConstruction) throw new Error("encoder unavailable");
    instance = this;
  }
  start() { this.state = "recording"; }
  stop() { stop(); this.state = "inactive"; this.onstop?.(); }
}
const canvasRef = { current: { captureStream: () => ({ getTracks: () => [{ stop: trackStop }] }) } } as unknown as { current: HTMLCanvasElement };
beforeEach(() => {
  container = installHostDom();
  root = createRoot(container as unknown as Element);
  failConstruction = false;
  trackStop.mockClear(); stop.mockClear();
  vi.stubGlobal("MediaRecorder", FakeRecorder);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
async function render(ready = true) {
  await act(async () => root.render(<I18nProvider locale="zh-TW"><CanvasCaptureControls canvasRef={canvasRef} ready={ready} label="test" /></I18nProvider>));
}
async function start() {
  const button = allNodes(container).find(n => n.tagName === "BUTTON" && props(n)["aria-label"] === "開始錄影");
  expect(button).toBeDefined();
  await act(async () => props(button!).onClick());
}
it("releases captured tracks when the encoder constructor rejects the stream", async () => {
  failConstruction = true;
  await render(); await start();
  expect(trackStop).toHaveBeenCalledOnce();
  expect(stop).not.toHaveBeenCalled();
});
it("stops recording and releases tracks when the remote canvas becomes unavailable", async () => {
  await render(); await start();
  expect(instance.state).toBe("recording");
  await render(false);
  expect(stop).toHaveBeenCalledOnce();
  expect(trackStop).toHaveBeenCalledOnce();
});
it("allows retrying recording after encoder construction fails", async () => {
  failConstruction = true;
  await render(); await start();
  failConstruction = false;
  await start();
  expect(instance.state).toBe("recording");
  await render(false);
  expect(trackStop).toHaveBeenCalledTimes(2);
});
