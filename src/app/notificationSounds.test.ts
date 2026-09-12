import { invoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  notificationToneSequence,
  notificationSoundChoices,
  playNotificationSound,
} from "./notificationSounds";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
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

});
