import { useEffect, useRef, useState, type RefObject } from "react";
import { speak, speechSynthesisAvailable, stopSpeaking, useDictation } from "../../app/sessionVoice";
import { localeCatalog } from "../../i18n/catalog";
import { useI18n } from "../../i18n/context";
import { MicIcon, SendIcon, WaveformIcon } from "../icons";

export function ComposerVoiceControls({ inputRef, draft, hasContent, blocked, working, sending, canSend,
  sendLabel, replyVersion, replyText, onText, onSubmit, onNotice }: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  hasContent: boolean;
  blocked: boolean;
  working: boolean;
  sending: boolean;
  canSend: boolean;
  sendLabel: string;
  replyVersion: string;
  replyText: string;
  onText: (text: string) => void;
  onSubmit: () => void;
  onNotice: (notice: string | null) => void;
}) {
  const { t, locale } = useI18n();
  const speechLang = localeCatalog.find(entry => entry.id === locale)?.tag ?? locale;
  const [voiceActive, setVoiceActive] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const mounted = useRef(true);
  const voiceGeneration = useRef(0);
  const spokenThrough = useRef(replyVersion);
  const submitRef = useRef(onSubmit);
  submitRef.current = onSubmit;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; voiceGeneration.current += 1; stopSpeaking(); };
  }, []);
  const dictation = useDictation({
    lang: speechLang,
    onText,
    onError: detail => {
      voiceGeneration.current += 1;
      setVoiceActive(false);
      stopSpeaking();
      setSpeaking(false);
      onNotice(t("sessionChat.voice.failed", { detail }));
    },
  });
  const voiceAvailable = dictation.mode !== null;
  function startDictation() {
    inputRef.current?.focus();
    void dictation.start();
  }
  function startVoice() {
    if (!voiceAvailable || blocked) return;
    voiceGeneration.current += 1;
    setVoiceActive(true);
    spokenThrough.current = replyVersion;
    onNotice(t(dictation.mode === "system" ? "sessionChat.voice.startedSystem"
      : dictation.mode === "local" ? "sessionChat.voice.startedLocal" : "sessionChat.voice.started"));
    startDictation();
  }
  function stopVoice() {
    voiceGeneration.current += 1;
    setVoiceActive(false);
    dictation.stop(true);
    stopSpeaking();
    setSpeaking(false);
    onNotice(null);
  }
  useEffect(() => {
    if (!voiceActive || !draft.trim() || blocked || working || !canSend || dictation.listening) return;
    const timer = setTimeout(() => submitRef.current(), 2500);
    return () => clearTimeout(timer);
  }, [voiceActive, draft, blocked, working, canSend, dictation.listening]);
  useEffect(() => {
    if (!voiceActive || blocked || working || speaking || draft.trim() || dictation.listening || dictation.mode === "system") return;
    const timer = setTimeout(() => { void dictation.start(); }, 300);
    return () => clearTimeout(timer);
  }, [voiceActive, blocked, working, speaking, draft, dictation.listening, dictation.mode, dictation.start]);
  useEffect(() => {
    if (!voiceActive || working || replyVersion === spokenThrough.current) return;
    spokenThrough.current = replyVersion;
    if (!replyText) return;
    const generation = voiceGeneration.current;
    dictation.stop(true);
    setSpeaking(true);
    void speak(replyText, speechLang).then(() => {
      if (mounted.current && generation === voiceGeneration.current) setSpeaking(false);
    });
  }, [voiceActive, working, replyVersion, replyText, speechLang, dictation]);
  const dictationTitle = !voiceAvailable ? t("sessionChat.dictation.unavailable")
    : dictation.mode === "system" ? t("sessionChat.dictation.system")
      : dictation.mode === "local" ? t("sessionChat.dictation.local") : t("sessionChat.dictation");
  const voiceTitle = !voiceAvailable ? t("sessionChat.voice.unavailable")
    : speechSynthesisAvailable() ? t("sessionChat.voice.start") : t("sessionChat.voice.startSilent");
  return <>
    <button type="button" className={`session-composer__icon${dictation.listening ? " is-active" : ""}`}
      disabled={!voiceAvailable || blocked} aria-label={dictationTitle} title={dictationTitle}
      aria-pressed={dictation.mode !== "system" ? dictation.listening : undefined}
      onClick={() => dictation.listening ? dictation.stop() : startDictation()}><MicIcon /></button>
    {voiceActive ? <button type="button" className="session-composer__voice is-active"
      aria-label={t("sessionChat.voice.stop")} title={t("sessionChat.voice.stop")} onClick={stopVoice}><WaveformIcon /></button>
      : hasContent || sending ? <button type="submit" className="chat-send" disabled={!canSend}
        aria-label={sendLabel} title={sendLabel}><SendIcon /></button>
        : <button type="button" className="session-composer__voice" disabled={!voiceAvailable || blocked}
          aria-label={voiceTitle} title={voiceTitle} onClick={startVoice}><WaveformIcon /></button>}
  </>;
}
