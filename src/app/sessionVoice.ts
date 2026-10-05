import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Dictation for the session composer.
 *
 * WebView2 exposes `webkitSpeechRecognition` without a speech service behind
 * it, so on Windows the desktop opens the system's own voice typing (Win+H),
 * which types into the focused input. Elsewhere the browser recogniser is
 * used when the web view provides one.
 */
export type DictationMode = "system" | "browser" | null;

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}

type RecognitionConstructor = new () => Recognition;

interface VoiceEnvironment {
  navigator?: { userAgent?: string };
  SpeechRecognition?: unknown;
  webkitSpeechRecognition?: unknown;
  speechSynthesis?: unknown;
}

function environment(): VoiceEnvironment {
  return globalThis as unknown as VoiceEnvironment;
}

function recognitionConstructor(env: VoiceEnvironment): RecognitionConstructor | null {
  const candidate = env.SpeechRecognition ?? env.webkitSpeechRecognition;
  return typeof candidate === "function" ? candidate as RecognitionConstructor : null;
}

export function dictationMode(env: VoiceEnvironment = environment()): DictationMode {
  const agent = env.navigator?.userAgent;
  if (!agent) return null;
  if (/Windows/i.test(agent)) return "system";
  return recognitionConstructor(env) ? "browser" : null;
}

export function useDictation({ lang, onText, onError }: {
  lang: string;
  onText: (text: string) => void;
  onError: (detail: string) => void;
}) {
  const mode = useMemo(() => dictationMode(), []);
  const [listening, setListening] = useState(false);
  const recognition = useRef<Recognition | null>(null);
  const latest = useRef({ onText, onError });
  latest.current = { onText, onError };
  useEffect(() => () => recognition.current?.abort(), []);

  const stop = useCallback(() => {
    recognition.current?.abort();
    recognition.current = null;
    setListening(false);
  }, []);

  const start = useCallback(async () => {
    if (mode === "system") {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("start_voice_typing");
      } catch (reason) {
        latest.current.onError(reason instanceof Error ? reason.message : String(reason));
      }
      return;
    }
    const Constructor = mode === "browser" ? recognitionConstructor(environment()) : null;
    if (!Constructor || recognition.current) return;
    const next = new Constructor();
    next.lang = lang;
    next.continuous = false;
    next.interimResults = false;
    next.onresult = event => {
      const text = Array.from(event.results).map(result => result[0]?.transcript ?? "").join("").trim();
      if (text) latest.current.onText(text);
    };
    next.onerror = event => {
      if (event.error && event.error !== "aborted" && event.error !== "no-speech") latest.current.onError(event.error);
    };
    next.onend = () => {
      if (recognition.current === next) recognition.current = null;
      setListening(false);
    };
    recognition.current = next;
    setListening(true);
    try {
      next.start();
    } catch (reason) {
      recognition.current = null;
      setListening(false);
      latest.current.onError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [mode, lang]);

  return { mode, listening, start, stop };
}

/** Markdown reduced to what is worth hearing; code is skipped, not spelled out. */
export function speakableText(markdown: string, limit = 1500): string {
  const text = markdown
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_~|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

interface Synthesis {
  speak(utterance: unknown): void;
  cancel(): void;
}

export function speechSynthesisAvailable(env: VoiceEnvironment = environment()): boolean {
  return Boolean(env.speechSynthesis) && typeof (globalThis as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance === "function";
}

/** Reads one reply aloud; resolves when it ends, is cancelled or fails. */
export function speak(text: string, lang: string): Promise<void> {
  if (!text || !speechSynthesisAvailable()) return Promise.resolve();
  const synthesis = environment().speechSynthesis as Synthesis;
  const Utterance = (globalThis as unknown as { SpeechSynthesisUtterance: new (text: string) => {
    lang: string; onend: (() => void) | null; onerror: (() => void) | null;
  } }).SpeechSynthesisUtterance;
  return new Promise(resolve => {
    const utterance = new Utterance(text);
    utterance.lang = lang;
    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();
    synthesis.speak(utterance);
  });
}

export function stopSpeaking() {
  if (speechSynthesisAvailable()) (environment().speechSynthesis as Synthesis).cancel();
}
