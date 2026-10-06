import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hasDesktopBackend } from "./nativeRuntime";

/**
 * Dictation for the session composer.
 *
 * WebView2 exposes `webkitSpeechRecognition` without a speech service behind
 * it, so on Windows the desktop opens the system's own voice typing (Win+H),
 * which types into the focused input. Elsewhere the browser recogniser is
 * used when the web view provides one.
 */
export type DictationMode = "system" | "browser" | "local" | null;

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
  const browserMode = useMemo(() => dictationMode(), []);
  const [localAvailable, setLocalAvailable] = useState(false);
  const mode = browserMode ?? (localAvailable ? "local" : null);
  const [listening, setListening] = useState(false);
  const recognition = useRef<Recognition | null>(null);
  const localRequest = useRef<string | null>(null);
  const mounted = useRef(true);
  const latest = useRef({ onText, onError });
  latest.current = { onText, onError };
  useEffect(() => {
    mounted.current = true;
    if (!browserMode && hasDesktopBackend()) {
      void import("@tauri-apps/api/core").then(({ invoke }) => invoke<boolean>("local_dictation_available"))
        .then(available => { if (mounted.current) setLocalAvailable(available); }).catch(() => undefined);
    }
    return () => {
      mounted.current = false;
      recognition.current?.abort();
      const requestId = localRequest.current;
      localRequest.current = null;
      if (requestId) void import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke("local_dictation_stop", { requestId, cancel: true })).catch(() => undefined);
    };
  }, [browserMode]);

  const stop = useCallback((cancel = false) => {
    const requestId = localRequest.current;
    if (requestId) {
      if (cancel) { localRequest.current = null; setListening(false); }
      void import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke("local_dictation_stop", { requestId, cancel })).catch(reason => {
          if (mounted.current) latest.current.onError(reason instanceof Error ? reason.message : String(reason));
        });
      return;
    }
    const previous = recognition.current;
    recognition.current = null;
    previous?.abort();
    setListening(false);
  }, []);

  const start = useCallback(async () => {
    if (mode === "local") {
      if (localRequest.current) return;
      const requestId = crypto.randomUUID();
      localRequest.current = requestId;
      setListening(true);
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        if (!mounted.current || localRequest.current !== requestId) return;
        const text = await invoke<string>("local_dictation_start", { requestId, lang });
        if (mounted.current && localRequest.current === requestId && text) latest.current.onText(text);
      } catch (reason) {
        if (mounted.current && localRequest.current === requestId) latest.current.onError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (localRequest.current === requestId) {
          localRequest.current = null;
          if (mounted.current) setListening(false);
        }
      }
      return;
    }
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
      if (!mounted.current || recognition.current !== next) return;
      const text = Array.from(event.results).map(result => result[0]?.transcript ?? "").join("").trim();
      if (text) latest.current.onText(text);
    };
    next.onerror = event => {
      if (!mounted.current || recognition.current !== next) return;
      if (event.error && event.error !== "aborted" && event.error !== "no-speech") latest.current.onError(event.error);
    };
    next.onend = () => {
      if (!mounted.current || recognition.current !== next) return;
      recognition.current = null;
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
export function spokenSessionReply(message?: { role: string; text: string; tool?: unknown }): string | null {
  return message?.role === "assistant" && !message.tool ? speakableText(message.text) : null;
}

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
