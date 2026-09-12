import { invoke } from "@tauri-apps/api/core";

import catalog from "./notificationSoundCatalog.json";

/** Original cue compositions shared with the native Windows PCM renderer. */
export type NotificationSoundChoice = "off" | keyof typeof catalog;
export const notificationSoundChoices: readonly NotificationSoundChoice[] = [
  "off", ...Object.keys(catalog) as (keyof typeof catalog)[],
];
export const notificationSoundGroups = [
  { id: "soft", sounds: ["bloom", "drift", "moon"] },
  { id: "bright", sounds: ["droplet", "glass", "spark"] },
  { id: "natural", sounds: ["marimba", "pluck", "bamboo"] },
  { id: "digital", sounds: ["orbit", "pulse", "arcade"] },
] as const;

interface NotificationTone {
  frequency: number;
  delay: number;
  duration: number;
  gain: number;
  type: OscillatorType;
}
export type NotificationPlaybackResult = "disabled" | "native" | "webAudio" | "unavailable";

export function normalizeNotificationSound(value: unknown): NotificationSoundChoice {
  const legacy: Record<string, NotificationSoundChoice> = {
    clear: "glass", gentle: "bloom", double: "pulse", wood: "marimba",
  };
  if (typeof value !== "string") return "bloom";
  if (notificationSoundChoices.includes(value as NotificationSoundChoice)) return value as NotificationSoundChoice;
  return Object.prototype.hasOwnProperty.call(legacy, value) ? legacy[value] : "bloom";
}
export function normalizeNotificationVolume(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(Math.min(100, Math.max(0, value))) : 60;
}
export function notificationToneSequence(sound: NotificationSoundChoice): readonly NotificationTone[] {
  return sound === "off" ? [] : catalog[sound] as NotificationTone[];
}

let sharedContext: AudioContext | null = null;
// Completion events and Settings previews can arrive together. Keep their
// short cues distinct instead of asking a platform mixer to replace one with
// another mid-playback.
let notificationPlaybackQueue: Promise<void> = Promise.resolve();

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AudioContextConstructor = (
    window as typeof window & { webkitAudioContext?: typeof AudioContext }
  ).AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioContextConstructor) return null;
  try {
    sharedContext ??= new AudioContextConstructor();
    return sharedContext;
  } catch {
    return null;
  }
}

/**
 * Unlocks Web Audio from a real user gesture. WebView2 can otherwise keep a
 * context suspended until long after the user submits work, causing the first
 * background completion cue to be silently rejected.
 */
export async function prepareNotificationAudio(): Promise<boolean> {
  const context = audioContext();
  if (!context) return false;
  try {
    if (context.state === "suspended") await context.resume();
    return context.state === "running";
  } catch {
    return false;
  }
}

/** Plays one short cue. Browser autoplay rejection is intentionally silent. */
async function playWebAudioSound(
  tones: readonly NotificationTone[],
  volume: number,
): Promise<boolean> {
  const context = audioContext();
  if (!context) return false;

  try {
    if (!(await prepareNotificationAudio())) return false;
    const start = context.currentTime + 0.015;
    for (const tone of tones) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const toneStart = start + tone.delay;
      const toneEnd = toneStart + tone.duration;
      oscillator.type = tone.type;
      oscillator.frequency.setValueAtTime(tone.frequency, toneStart);
      gain.gain.setValueAtTime(0.0001, toneStart);
      gain.gain.exponentialRampToValueAtTime(tone.gain * volume / 100, toneStart + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, toneEnd);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(toneStart);
      oscillator.stop(toneEnd + 0.01);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * (0.03 + Math.max(...tones.map((tone) => tone.delay + tone.duration)))));
    return true;
  } catch {
    return false;
  }
}

async function playNotificationSoundNow(
  sound: NotificationSoundChoice,
  volume = 60,
): Promise<NotificationPlaybackResult> {
  const tones = notificationToneSequence(sound);
  if (tones.length === 0) return "disabled";

  if (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window
  ) {
    try {
      if (await invoke<boolean>("play_notification_sound", { sound, volume })) {
        return "native";
      }
    } catch {
      // Non-Windows desktop builds and older backends fall through to Web Audio.
    }
  }

  return (await playWebAudioSound(tones, volume)) ? "webAudio" : "unavailable";
}

export function playNotificationSound(
  sound: NotificationSoundChoice,
  volume = 60,
): Promise<NotificationPlaybackResult> {
  volume = normalizeNotificationVolume(volume);
  if (volume === 0 || notificationToneSequence(sound).length === 0) {
    return Promise.resolve("disabled");
  }

  const playback = notificationPlaybackQueue.then(
    () => playNotificationSoundNow(sound, volume),
    () => playNotificationSoundNow(sound, volume),
  );
  notificationPlaybackQueue = playback.then(
    () => undefined,
    () => undefined,
  );
  return playback;
}
