import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useCliProxySettings } from "../../app/useCliProxyApi";
import { useI18n } from "../../i18n/context";
import { ChatImageStrip } from "./ChatImagePreviews";
interface Frame { notice?: string | null; image: string | null; width: number; height: number; fingerprint?: string; url?: string; title?: string }
export function ChatTools({ threadId, directory, busy, assistantTools, browserEnabled, onBrowserEnabled, onClose }: { threadId: string; directory: string; busy: boolean; assistantTools: boolean; browserEnabled: boolean; onBrowserEnabled?: (enabled: boolean) => void; onClose: () => void }) {
  const { t } = useI18n(); const { proxies } = useCliProxySettings();
  const [tab, setTab] = useState<"browser" | "computer" | "images">("browser");
  const [frames, setFrames] = useState<Partial<Record<"browser" | "computer", Frame>>>({});
  const [started, setStarted] = useState(false); const [computer, setComputer] = useState(false); const [configured, setConfigured] = useState(false);
  const [url, setUrl] = useState("https://example.com"); const [text, setText] = useState("");
  const [proxyId, setProxyId] = useState(proxies[0]?.id ?? ""); const [model, setModel] = useState(""); const [prompt, setPrompt] = useState(""); const [image, setImage] = useState("");
  const [working, setWorking] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const mounted = useRef(true); const lock = useRef(false); const frameRef = useRef(frames); frameRef.current = frames;
  useEffect(() => { mounted.current = true; void invoke<{ computer: boolean; images: boolean; imageSource?: { proxyId: string; model: string } | null }>("chat_tools_status", { threadId }).then(status => { if (mounted.current) { setComputer(status.computer); setConfigured(status.images); if (status.imageSource) { setProxyId(status.imageSource.proxyId); setModel(status.imageSource.model); } } }).catch(() => {}); return () => { mounted.current = false; }; }, [threadId]);
  useEffect(() => { const stopComputer = () => { setComputer(false); setFrames(current => ({ ...current, computer: undefined })); void invoke("chat_computer_enable", { threadId, enabled: false }).catch(() => {}); }; window.addEventListener("focus", stopComputer); return () => window.removeEventListener("focus", stopComputer); }, [threadId]);
  async function act(action: () => Promise<void>, quiet = false) {
    if (lock.current) return; lock.current = true; setWorking(true); if (!quiet) { setError(""); setNotice(""); }
    try { await action(); } catch (reason) { if (mounted.current) setError(String(reason)); } finally { lock.current = false; if (mounted.current) setWorking(false); }
  }
  async function command(target: "browser" | "computer", action: string, args: Record<string, unknown> = {}) {
    const frame = await invoke<Frame>(target === "browser" ? "chat_browser_action" : "chat_computer_action", { threadId, action, args: { ...args, ...(target === "computer" && action !== "capture" ? { fingerprint: frameRef.current.computer?.fingerprint } : {}) } });
    if (mounted.current && frame.notice) setNotice(frame.notice);
    if (mounted.current && frame.image) { setFrames(current => ({ ...current, [target]: frame })); if (frame.url && target === "browser") setUrl(frame.url); }
  }
  useEffect(() => {
    if (tab !== "browser" || !started) return;
    let active = true; let timer: ReturnType<typeof setTimeout>;
    async function refresh() { await act(() => command(tab as "browser" | "computer", tab === "browser" ? "screenshot" : "capture"), true); if (active) timer = setTimeout(() => void refresh(), 1500); }
    void refresh(); return () => { active = false; clearTimeout(timer); };
  }, [tab, started, computer, threadId]);
  const frame = tab === "images" ? undefined : frames[tab];
  const unavailable = busy || working || (tab === "browser" ? !started : !computer);
  return <section className="chat-tools" aria-label={t("chat.tools.title")}>
    <header><div role="tablist">{(["browser", "computer", "images"] as const).map(id => <button type="button" key={id} role="tab" aria-selected={tab === id} className="button button--ghost button--sm" onClick={() => { setTab(id); setError(""); }}>{t(`chat.tools.${id}`)}</button>)}</div><button type="button" className="button button--ghost button--sm" onClick={onClose}>{t("chat.tools.close")}</button></header>
    {!assistantTools && <p className="chat-settings__hint">{t("chat.tools.nativeOnly")}</p>}
    {tab === "browser" && assistantTools && onBrowserEnabled && <label className="chat-tools__permission"><input type="checkbox" checked={browserEnabled} disabled={busy || working} onChange={event => onBrowserEnabled(event.target.checked)} />{t("chat.tools.browserGrant")}</label>}
    {error && <p role="alert" className="field__error">{error}</p>}{notice && <p role="status">{notice}</p>}
    {tab === "browser" && <form className="chat-tools__toolbar" onSubmit={event => { event.preventDefault(); if (!busy) void act(async () => { await command("browser", "navigate", { url }); setStarted(true); }); }}>
      <button type="button" className="button button--ghost button--sm" disabled={unavailable} aria-label={t("chat.tools.back")} onClick={() => void act(() => command("browser", "back"))}>←</button>
      <button type="button" className="button button--ghost button--sm" disabled={unavailable} aria-label={t("chat.tools.forward")} onClick={() => void act(() => command("browser", "forward"))}>→</button>
      <input className="input" type="url" value={url} onChange={event => setUrl(event.target.value)} disabled={working || busy} aria-label={t("chat.tools.url")} required />
      <button className="button button--secondary button--sm" disabled={working || busy}>{t("chat.tools.go")}</button>
      <button type="button" className="button button--ghost button--sm" disabled={unavailable} onClick={() => void act(() => command("browser", "reload"))}>{t("chat.tools.reload")}</button>
      {started && <button type="button" className="button button--ghost button--sm" disabled={working || busy} onClick={() => void act(async () => { setStarted(false); await invoke("chat_browser_action", { threadId, action: "close", args: {} }); setFrames(current => ({ ...current, browser: undefined })); })}>{t("chat.tools.stopBrowser")}</button>}
    </form>}
    {tab === "computer" && <label className="chat-tools__permission"><input type="checkbox" checked={computer} disabled={working || !assistantTools} onChange={event => { const enabled = event.target.checked; void act(async () => { await invoke("chat_computer_enable", { threadId, enabled, startNow: busy }); setComputer(enabled); if (!enabled) setFrames(current => ({ ...current, computer: undefined })); }); }} />{t("chat.tools.computerGrant")}</label>}
    {tab === "computer" && <p className="chat-settings__hint">{t("chat.tools.computerHint")}</p>}
    {tab === "browser" && <>
      <p className="chat-settings__hint">{t(tab === "browser" ? "chat.tools.browserHint" : "chat.tools.computerHint")}</p>
      <div className="chat-tools__screen">{frame?.image ? <img src={`data:image/jpeg;base64,${frame.image}`} alt={frame.title ?? t(`chat.tools.${tab}`)} tabIndex={0}
        onClick={event => { if (unavailable) return; const rect = event.currentTarget.getBoundingClientRect(); void act(() => command(tab, "click", { x: Math.floor((event.clientX - rect.left) * frame.width / rect.width), y: Math.floor((event.clientY - rect.top) * frame.height / rect.height) })); }}
        onKeyDown={event => { if (unavailable || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey || !["Enter", "Tab", "Escape", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return; event.preventDefault(); void act(() => command(tab, "key", { key: event.key })); }} /> : <p>{t("chat.tools.noFrame")}</p>}</div>
      <form className="chat-tools__toolbar" onSubmit={event => { event.preventDefault(); if (!unavailable && text) void act(async () => { await command(tab, "type", { text }); setText(""); }); }}>
        <input className="input" value={text} onChange={event => setText(event.target.value)} disabled={unavailable} aria-label={t("chat.tools.type")} placeholder={t("chat.tools.type")} />
        <button className="button button--secondary button--sm" disabled={unavailable || !text}>{t("chat.tools.sendText")}</button>
        <button type="button" className="button button--ghost button--sm" disabled={unavailable} onClick={() => void act(() => command(tab, "key", { key: "Enter" }))}>Enter</button>
        {[-1, 1].map(direction => <button key={direction} type="button" className="button button--ghost button--sm" disabled={unavailable} aria-label={t(direction < 0 ? "chat.tools.scrollUp" : "chat.tools.scrollDown")} onClick={() => void act(() => command(tab, "scroll", tab === "browser" ? { delta: direction * 500 } : { units: direction * 3 }))}>{direction < 0 ? "↑" : "↓"}</button>)}
      </form>
    </>}
    {tab === "images" && <>
      <p className="chat-settings__hint">{t("chat.tools.imageHint")}</p>
      <form className="chat-tools__toolbar" onSubmit={event => { event.preventDefault(); const source = proxies.find(proxy => proxy.id === proxyId); if (source) void act(async () => { await invoke("chat_image_configure", { threadId, source: { baseUrl: source.baseUrl, proxyId: source.id, model } }); setConfigured(true); setNotice(t("chat.tools.configured")); }); }}>
        <select className="input" value={proxyId} onChange={event => setProxyId(event.target.value)} disabled={working || busy} aria-label={t("chat.tools.imageSource")}><option value="">{t("chat.tools.selectSource")}</option>{proxies.map(proxy => <option key={proxy.id} value={proxy.id}>{proxy.label || proxy.baseUrl}</option>)}</select>
        <input className="input" value={model} onChange={event => setModel(event.target.value)} disabled={working || busy} aria-label={t("chat.tools.imageModel")} placeholder={t("chat.tools.imageModel")} required />
        <button className="button button--secondary button--sm" disabled={working || busy || !proxyId || !model.trim()}>{t("chat.tools.configure")}</button>
        {configured && <button type="button" className="button button--ghost button--sm" disabled={working || busy} onClick={() => void act(async () => { await invoke("chat_image_configure", { threadId, source: null }); setConfigured(false); })}>{t("chat.tools.disableImages")}</button>}
      </form>
      <form onSubmit={event => { event.preventDefault(); if (!busy && configured) void act(async () => { const result = await invoke<{ path: string }>("chat_image_generate", { threadId, prompt }); setImage(result.path); setNotice(t("chat.tools.generated")); }); }}>
        <textarea className="input" value={prompt} onChange={event => setPrompt(event.target.value)} disabled={working || busy || !configured} placeholder={t("chat.tools.imagePrompt")} aria-label={t("chat.tools.imagePrompt")} rows={3} />
        <button className="button button--primary button--sm" disabled={working || busy || !configured || !prompt.trim()}>{t(working ? "chat.tools.generating" : "chat.tools.generate")}</button>
      </form>
      {image && <ChatImageStrip paths={[image]} workingDirectory={directory} threadId={threadId} captions={false} />}
    </>}
  </section>;
}
