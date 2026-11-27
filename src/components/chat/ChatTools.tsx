import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useCliProxySettings } from "../../app/useCliProxyApi";
import { useI18n } from "../../i18n/context";
import { ChatImageStrip } from "./ChatImagePreviews";
interface BrowserTab { id: string; url: string; title: string }
interface Frame { notice?: string | null; image: string | null; width: number; height: number; fingerprint?: string; url?: string; title?: string; tabId?: string; tabs?: BrowserTab[] }
const browserKeys = new Set(["Enter", "Tab", "Escape", "Backspace", "Delete", "Home", "End", "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

function browserPoint(image: HTMLImageElement, frame: Frame, clientX: number, clientY: number) {
  const rect = image.getBoundingClientRect();
  if (!rect.width || !rect.height || !frame.width || !frame.height) return;
  return {
    x: Math.max(0, Math.min(frame.width - 1, Math.floor((clientX - rect.left) * frame.width / rect.width))),
    y: Math.max(0, Math.min(frame.height - 1, Math.floor((clientY - rect.top) * frame.height / rect.height))),
  };
}
export function ChatTools({ threadId, directory, busy, assistantTools, browserEnabled, onBrowserEnabled, onClose }: { threadId: string; directory: string; busy: boolean; assistantTools: boolean; browserEnabled: boolean; onBrowserEnabled?: (enabled: boolean) => void; onClose: () => void }) {
  const { t } = useI18n(); const { proxies } = useCliProxySettings();
  const [tab, setTab] = useState<"browser" | "computer" | "images">("browser");
  const [frames, setFrames] = useState<Partial<Record<"browser" | "computer", Frame>>>({});
  const [computer, setComputer] = useState(false); const [configured, setConfigured] = useState(false);
  const [isolated, setIsolated] = useState<boolean | null>(null);
  const [urlDraft, setUrlDraft] = useState<string | null>(null); const [text, setText] = useState("");
  const [proxyId, setProxyId] = useState(proxies[0]?.id ?? ""); const [model, setModel] = useState(""); const [prompt, setPrompt] = useState(""); const [image, setImage] = useState("");
  const [working, setWorking] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [browserImage, setBrowserImage] = useState<HTMLImageElement | null>(null);
  const wheelHandler = useRef<(event: WheelEvent) => void>(() => {});
  const browserInput = useRef<Promise<void>>(Promise.resolve());
  const pendingInput = useRef(0);
  const previewRevision = useRef(0);
  const browserBusy = useRef(busy); browserBusy.current = busy;
  const mounted = useRef(true); const lock = useRef(false); const frameRef = useRef(frames); frameRef.current = frames;
  useEffect(() => { mounted.current = true; void invoke<{ computer: boolean; isolated: boolean; images: boolean; imageSource?: { proxyId: string; model: string } | null }>("chat_tools_status", { threadId }).then(status => { if (mounted.current) { setIsolated(status.isolated === true); setComputer(status.computer); setConfigured(status.images); if (status.imageSource) { setProxyId(status.imageSource.proxyId); setModel(status.imageSource.model); } } }).catch(() => {}); return () => { mounted.current = false; }; }, [threadId]);
  useEffect(() => { if (isolated !== false) return; const stopComputer = () => { setComputer(false); setFrames(current => ({ ...current, computer: undefined })); void invoke("chat_computer_enable", { threadId, enabled: false }).catch(() => {}); }; window.addEventListener("focus", stopComputer); return () => window.removeEventListener("focus", stopComputer); }, [threadId, isolated]);
  async function act(action: () => Promise<void>) {
    if (lock.current || pendingInput.current) return;
    lock.current = true; previewRevision.current++; setWorking(true); setError(""); setNotice("");
    try { await action(); } catch (reason) { if (mounted.current) setError(String(reason)); } finally { lock.current = false; if (mounted.current) setWorking(false); }
  }
  async function command(target: "browser" | "computer", action: string, args: Record<string, unknown> = {}) {
    const tabId = target === "browser" ? frameRef.current.browser?.tabId : undefined;
    const frame = await invoke<Frame>(target === "browser" ? "chat_browser_action" : "chat_computer_action", { threadId, action, args: { tabId, ...args, ...(target === "computer" && action !== "capture" ? { fingerprint: frameRef.current.computer?.fingerprint } : {}) } });
    if (!mounted.current || !frame) return;
    if (frame.notice) setNotice(frame.notice);
    if (target === "browser" || frame.image) setFrames(current => ({ ...current, [target]: frame }));
    if (target === "browser" && ["navigate", "back", "forward", "open", "new_tab", "activate_tab", "close_tab"].includes(action)) setUrlDraft(null);
  }
  useEffect(() => {
    if (tab !== "browser") return;
    let active = true; let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        if (lock.current || pendingInput.current) return;
        const revision = previewRevision.current;
        const frame = await invoke<Frame>("chat_browser_action", { threadId, action: "preview", args: {} }).catch(() => null);
        if (!active || !frame || revision !== previewRevision.current) return;
        setFrames(current => ({ ...current, browser: frame }));
      } finally {
        if (active) timer = setTimeout(() => void refresh(), 1500);
      }
    }
    void refresh(); return () => { active = false; clearTimeout(timer); };
  }, [tab, threadId]);
  const frame = tab === "images" ? undefined : frames[tab];
  const browserTabs = frames.browser?.tabs ?? [];
  const url = urlDraft ?? (frames.browser?.url === "about:blank" ? "" : frames.browser?.url ?? "");
  const unavailable = busy || working || (tab === "browser" ? !frame?.tabId : !computer);
  function queueBrowserInput(action: string, args: Record<string, unknown>) {
    if (lock.current || pendingInput.current >= 64 || !frame?.tabId) return;
    const tabId = frame.tabId;
    pendingInput.current++;
    previewRevision.current++;
    browserInput.current = browserInput.current.then(async () => {
      if (!mounted.current || browserBusy.current || frameRef.current.browser?.tabId !== tabId) return;
      await command("browser", action, { ...args, tabId, inputOnly: true });
    }).catch(reason => {
      if (mounted.current) setError(String(reason));
    }).finally(() => { pendingInput.current--; });
  }
  wheelHandler.current = event => {
    if (event.ctrlKey || event.metaKey || busy || !frame?.tabId || !browserImage) return;
    const point = browserPoint(browserImage, frame, event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? frame.height : 1;
    const limit = (delta: number) => Math.max(-2400, Math.min(2400, delta * scale));
    queueBrowserInput("scroll", { ...point, delta: limit(event.deltaY), deltaX: limit(event.deltaX) });
  };
  useEffect(() => {
    if (!browserImage) return;
    const onWheel = (event: WheelEvent) => wheelHandler.current(event);
    browserImage.addEventListener("wheel", onWheel, { passive: false });
    return () => browserImage.removeEventListener("wheel", onWheel);
  }, [browserImage]);

  function clickBrowser(event: MouseEvent<HTMLImageElement>) {
    if (busy || !frame?.tabId) return;
    const point = browserPoint(event.currentTarget, frame, event.clientX, event.clientY);
    if (point) {
      event.currentTarget.focus();
      queueBrowserInput("click", point);
    }
  }

  function keyBrowser(event: KeyboardEvent<HTMLImageElement>) {
    if (event.key === "Tab" && event.shiftKey) return;
    if (busy || !frame?.tabId || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (browserKeys.has(event.key)) {
      event.preventDefault();
      queueBrowserInput("key", { key: event.key });
    } else if ([...event.key].length === 1) {
      event.preventDefault();
      queueBrowserInput("type", { text: event.key });
    }
  }
  return <section className="chat-tools" aria-label={t("chat.tools.title")}>
    <header><div role="tablist">{(["browser", "computer", "images"] as const).map(id => <button type="button" key={id} role="tab" aria-selected={tab === id} className="button button--ghost button--sm" onClick={() => { setTab(id); setError(""); }}>{t(`chat.tools.${id}`)}</button>)}</div><button type="button" className="button button--ghost button--sm" onClick={onClose}>{t("chat.tools.close")}</button></header>
    {!assistantTools && <p className="chat-settings__hint">{t("chat.tools.nativeOnly")}</p>}
    {tab === "browser" && assistantTools && onBrowserEnabled && <label className="chat-tools__permission"><input type="checkbox" checked={browserEnabled} disabled={busy || working} onChange={event => onBrowserEnabled(event.target.checked)} />{t("chat.tools.browserGrant")}</label>}
    {error && <p role="alert" className="field__error">{error}</p>}{notice && <p role="status">{notice}</p>}
    {tab === "browser" && <div className="chat-tools__toolbar" role="group" aria-label={t("chat.tools.browserTabs")}>
      {browserTabs.map(page => <button key={page.id} type="button" className="button button--ghost button--sm" title={page.url} aria-pressed={page.id === frame?.tabId} disabled={busy || working} onClick={() => void act(() => command("browser", "activate_tab", { tabId: page.id }))}>{(page.title || (page.url !== "about:blank" && page.url) || t("chat.tools.newTab")).slice(0, 48)}</button>)}
      <button type="button" className="button button--ghost button--sm" disabled={busy || working} onClick={() => void act(() => command("browser", browserTabs.length ? "new_tab" : "open"))}>＋ {t(browserTabs.length ? "chat.tools.newTab" : "chat.tools.openBrowser")}</button>
      {browserTabs.length > 1 && <button type="button" className="button button--ghost button--sm" disabled={unavailable} onClick={() => void act(() => command("browser", "close_tab"))}>{t("chat.tools.closeTab")}</button>}
    </div>}
    {tab === "browser" && <form className="chat-tools__toolbar" onSubmit={event => { event.preventDefault(); if (!busy) void act(() => command("browser", "navigate", { url })); }}>
      <button type="button" className="button button--ghost button--sm" disabled={unavailable} aria-label={t("chat.tools.back")} onClick={() => void act(() => command("browser", "back"))}>←</button>
      <button type="button" className="button button--ghost button--sm" disabled={unavailable} aria-label={t("chat.tools.forward")} onClick={() => void act(() => command("browser", "forward"))}>→</button>
      <input className="input" type="url" value={url} onChange={event => setUrlDraft(event.target.value)} disabled={busy} aria-label={t("chat.tools.url")} placeholder="https://example.com" required />
      <button className="button button--secondary button--sm" disabled={working || busy}>{t("chat.tools.go")}</button>
      <button type="button" className="button button--ghost button--sm" disabled={unavailable} onClick={() => void act(() => command("browser", "reload"))}>{t("chat.tools.reload")}</button>
      {browserTabs.length > 0 && <button type="button" className="button button--ghost button--sm" disabled={working || busy} onClick={() => void act(async () => { await invoke("chat_browser_action", { threadId, action: "close", args: {} }); setFrames(current => ({ ...current, browser: undefined })); setUrlDraft(null); })}>{t("chat.tools.stopBrowser")}</button>}
    </form>}
    {tab === "computer" && isolated === false && <label className="chat-tools__permission"><input type="checkbox" checked={computer} disabled={working || !assistantTools} onChange={event => { const enabled = event.target.checked; void act(async () => { await invoke("chat_computer_enable", { threadId, enabled, startNow: busy }); setComputer(enabled); if (!enabled) setFrames(current => ({ ...current, computer: undefined })); }); }} />{t("chat.tools.computerGrant")}</label>}
    {tab === "computer" && isolated !== null && <p className="chat-settings__hint">{t(isolated ? "chat.tools.sandboxHint" : "chat.tools.computerHint")}</p>}
    {tab === "browser" && <>
      <div className="chat-tools__toolbar">
        <p className="chat-settings__hint">{t("chat.tools.browserHint")}</p>
        {frame?.image && <button type="button" className="button button--ghost button--sm" aria-pressed={expanded} onClick={() => setExpanded(value => !value)}>{t("chat.tools.expandBrowser")}</button>}
      </div>
      <div className={`chat-tools__screen${expanded ? " chat-tools__screen--expanded" : ""}`}>{frame?.image ? <img ref={setBrowserImage} src={`data:image/jpeg;base64,${frame.image}`} alt={frame.title || t("chat.tools.browser")} tabIndex={0} style={{ width: `min(100%, calc(var(--browser-preview-height) * ${frame.width / frame.height}))` }}
        draggable={false} onClick={clickBrowser} onKeyDown={keyBrowser} onPaste={event => {
          if (busy || !frame?.tabId) return;
          const pasted = event.clipboardData.getData("text/plain");
          if (pasted) { event.preventDefault(); queueBrowserInput("type", { text: pasted }); }
        }} /> : <p>{t("chat.tools.noFrame")}</p>}</div>
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
