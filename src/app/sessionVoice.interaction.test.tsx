import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { useDictation } from "./sessionVoice";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  vi.stubGlobal("navigator", { userAgent: "Linux" });
  vi.stubGlobal("SpeechRecognition", undefined);
  vi.stubGlobal("webkitSpeechRecognition", undefined);
  invoke.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

it("enables local dictation only after capability discovery and appends its transcript", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  const onText = vi.fn();
  const onError = vi.fn();
  let api!: ReturnType<typeof useDictation>;
  let finish!: (text: string) => void;
  invoke.mockImplementation((command: string) => command === "local_dictation_available"
    ? Promise.resolve(true) : new Promise(resolve => { finish = resolve; }));
  function Probe() { api = useDictation({ lang: "zh-TW", onText, onError }); return null; }
  try {
    await act(async () => { root.render(<Probe />); });
    expect(api.mode).toBe("local");
    let started!: Promise<void>;
    await act(async () => { started = api.start(); });
    expect(api.listening).toBe(true);
    expect(invoke).toHaveBeenCalledWith("local_dictation_start", { requestId: expect.any(String), lang: "zh-TW" });
    await act(async () => { finish("明天要做的事情"); await started; });
    expect(onText).toHaveBeenCalledExactlyOnceWith("明天要做的事情");
    expect(api.listening).toBe(false);
    expect(onError).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});

it("finishes recording on a second click and cancels only its own job on unmount", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let api!: ReturnType<typeof useDictation>;
  const onText = vi.fn();
  let finish!: (text: string) => void;
  invoke.mockImplementation((command: string) => command === "local_dictation_start"
    ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(true));
  function Probe() { api = useDictation({ lang: "zh-TW", onText, onError: vi.fn() }); return null; }
  await act(async () => { root.render(<Probe />); });
  let started!: Promise<void>;
  await act(async () => { started = api.start(); });
  const requestId = invoke.mock.calls.find(([command]) => command === "local_dictation_start")![1].requestId;
  await act(async () => { api.stop(); });
  expect(invoke).toHaveBeenCalledWith("local_dictation_stop", { requestId, cancel: false });
  await act(async () => root.unmount());
  expect(invoke).toHaveBeenCalledWith("local_dictation_stop", { requestId, cancel: true });
  await act(async () => { finish("stale"); await started; });
  expect(onText).not.toHaveBeenCalled();
});

it("keeps unsupported setups disabled without recording audio", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let api!: ReturnType<typeof useDictation>;
  invoke.mockResolvedValue(false);
  function Probe() { api = useDictation({ lang: "zh-TW", onText: vi.fn(), onError: vi.fn() }); return null; }
  try {
    await act(async () => { root.render(<Probe />); });
    expect(api.mode).toBeNull();
    await act(async () => { await api.start(); });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("local_dictation_available");
  } finally { await act(async () => root.unmount()); }
});

it("reports native recording failures and releases the listening state", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let api!: ReturnType<typeof useDictation>;
  const onError = vi.fn();
  const onText = vi.fn();
  invoke.mockImplementation((command: string) => command === "local_dictation_available"
    ? Promise.resolve(true) : Promise.reject(new Error("Microphone recording failed")));
  function Probe() { api = useDictation({ lang: "zh-TW", onText, onError }); return null; }
  try {
    await act(async () => { root.render(<Probe />); });
    await act(async () => { await api.start(); });
    expect(api.listening).toBe(false);
    expect(onText).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledExactlyOnceWith("Microphone recording failed");
  } finally { await act(async () => root.unmount()); }
});
