import { invoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  notificationToneSequence,
  notificationSoundChoices,
  playCompletionSound,
  playNotificationSound,
  resetCompletionSoundForTests,
} from "./notificationSounds";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(() => {
  resetCompletionSoundForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.mocked(invoke).mockReset();
});

describe("notification sounds", () => {
  it("keeps off silent and gives every named sound a short sequence", () => {
    expect(notificationToneSequence("off")).toEqual([]);
    for (const sound of notificationSoundChoices.filter((sound) => sound !== "off")) {
      const tones = notificationToneSequence(sound);
      expect(tones.length).toBeGreaterThan(0);
      expect(Math.max(...tones.map((tone) => tone.delay + tone.duration))).toBeLessThan(
        0.75,
      );
    }
  });

  it("uses the native desktop player before Web Audio", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    vi.mocked(invoke).mockResolvedValue(true);

    await expect(playNotificationSound("glass")).resolves.toBe("native");
    expect(invoke).toHaveBeenCalledWith("play_notification_sound", {
      sound: "glass",
      volume: 60,
    });
  });

  it("queues simultaneous native cues instead of overlapping them", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    let releaseFirst: ((value: boolean) => void) | undefined;
    vi.mocked(invoke)
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(true);

    const first = playNotificationSound("glass");
    const second = playNotificationSound("pulse");
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledTimes(1);

    releaseFirst?.(true);
    await expect(first).resolves.toBe("native");
    await expect(second).resolves.toBe("native");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("reports when neither native nor Web Audio playback is available", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    vi.mocked(invoke).mockResolvedValue(false);

    await expect(playNotificationSound("bloom")).resolves.toBe("unavailable");
  });
  it("keeps zero volume silent without opening a native player", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    await expect(playNotificationSound("glass", 0)).resolves.toBe("disabled");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("serializes Web Audio previews through the end of each cue", async () => {
    vi.useFakeTimers();
    const peaks: number[] = [];
    const starts = vi.fn();
    class Context {
      state = "running";
      currentTime = 0;
      destination = {};
      createOscillator() { return { frequency: { setValueAtTime: vi.fn() }, connect: vi.fn(), start: starts, stop: vi.fn() }; }
      createGain() { return { connect: vi.fn(), gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: (value: number) => peaks.push(value) } }; }
    }
    vi.stubGlobal("window", { AudioContext: Context });
    const first = playNotificationSound("glass", 25);
    const second = playNotificationSound("pulse", 25);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toHaveBeenCalledTimes(notificationToneSequence("glass").length);
    expect(peaks[0]).toBeCloseTo(notificationToneSequence("glass")[0].gain * 0.25);
    await vi.runAllTimersAsync();
    await expect(first).resolves.toBe("webAudio");
    await expect(second).resolves.toBe("webAudio");
    expect(starts).toHaveBeenCalledTimes(notificationToneSequence("glass").length + notificationToneSequence("pulse").length);
  });


  it("plays one completion cue when many tasks finish together", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    vi.mocked(invoke).mockResolvedValue(true);

    const results = await Promise.all([
      playCompletionSound("glass", 60, 10_000),
      playCompletionSound("glass", 60, 10_100),
      playCompletionSound("glass", 60, 14_900),
    ]);
    expect(results).toEqual(["native", "disabled", "disabled"]);
    expect(invoke).toHaveBeenCalledTimes(1);

    await expect(playCompletionSound("glass", 60, 15_000)).resolves.toBe("native");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("does not let a muted completion hide the next audible one", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    vi.mocked(invoke).mockResolvedValue(true);

    await expect(playCompletionSound("glass", 0, 10_000)).resolves.toBe("disabled");
    await expect(playCompletionSound("glass", 60, 10_100)).resolves.toBe("native");
  });

  it("allows recovery immediately after an unavailable completion", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    vi.mocked(invoke).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await expect(playCompletionSound("glass", 60, 10_000)).resolves.toBe("unavailable");
    await expect(playCompletionSound("glass", 60, 10_100)).resolves.toBe("native");
  });

  it("releases a stalled resume without playing the expired cue later", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const { playNotificationSound: playIsolatedSound } = await import("./notificationSounds");
    let finishResume!: () => void;
    const starts = vi.fn();
    class PendingContext {
      state = "suspended";
      currentTime = 0;
      destination = {};
      resume = () => new Promise<void>(resolve => { finishResume = () => { this.state = "running"; resolve(); }; });
      createOscillator() { return { frequency: { setValueAtTime: vi.fn() }, connect: vi.fn(), start: starts, stop: vi.fn() }; }
      createGain() { return { connect: vi.fn(), gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() } }; }
    }
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, AudioContext: PendingContext });
    vi.mocked(invoke).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    let firstResult: string | null = null;
    void playIsolatedSound("glass").then(result => { firstResult = result; });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(firstResult).toBe("unavailable");
    await expect(playIsolatedSound("glass")).resolves.toBe("native");
    finishResume();
    await vi.advanceTimersByTimeAsync(1000);
    expect(starts).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("bounds an unknown native outcome without a duplicate fallback and recovers", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const { playCompletionSound: playIsolatedCompletion } = await import("./notificationSounds");
    let finishNative!: (result: boolean) => void;
    const construct = vi.fn();
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, AudioContext: construct });
    vi.mocked(invoke).mockImplementationOnce(() => new Promise(resolve => { finishNative = resolve as typeof finishNative; })).mockResolvedValueOnce(true);
    const first = playIsolatedCompletion("glass", 60, 10_000);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(first).resolves.toBe("unavailable");
    await expect(playIsolatedCompletion("glass", 60, 12_100)).resolves.toBe("native");
    finishNative(true);
    await vi.advanceTimersByTimeAsync(1);
    await expect(playIsolatedCompletion("glass", 60, 12_200)).resolves.toBe("disabled");
    expect(construct).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("recreates a closed context and falls back after native rejection", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const audio = await import("./notificationSounds");
    const contexts: Context[] = [];
    const starts = vi.fn();
    class Context {
      state = "running";
      currentTime = 0;
      destination = {};
      constructor() { contexts.push(this); }
      createOscillator() { return { frequency: { setValueAtTime: vi.fn() }, connect: vi.fn(), start: starts, stop: vi.fn() }; }
      createGain() { return { connect: vi.fn(), gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() } }; }
    }
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, AudioContext: Context });
    vi.mocked(invoke).mockRejectedValue(new Error("Synthetic native unavailable"));
    expect(await audio.prepareNotificationAudio()).toBe(true);
    contexts[0].state = "closed";
    const playback = audio.playNotificationSound("glass");
    await vi.runAllTimersAsync();
    await expect(playback).resolves.toBe("webAudio");
    expect(contexts).toHaveLength(2);
    expect(starts).toHaveBeenCalledTimes(notificationToneSequence("glass").length);
  });
});
