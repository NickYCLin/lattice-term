import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { composerToken, insertProjectMention, searchProjectFiles, slashCommandIds, type ProjectFile, type ProjectFileResult, type SlashCommandId } from "../../app/composerAssistance";
import { useI18n } from "../../i18n/context";

export function useComposerAssistance({ draft, onText, inputRef, workingDirectory, onFile, commands, filesEnabled = true }: {
  draft: string;
  onText: (text: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  workingDirectory: string;
  filesEnabled?: boolean;
  onFile: (file: ProjectFile) => boolean;
  commands: Partial<Record<SlashCommandId, () => void>>;
}) {
  const { t } = useI18n();
  const id = useId();
  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(draft.length);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [files, setFiles] = useState<{ query: string; directory: string; result: ProjectFileResult } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const pendingCaret = useRef<{ text: string; caret: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const token = composerToken(draft, Math.min(caret, draft.length));
  const key = token ? JSON.stringify([token.kind, token.query, token.start, workingDirectory]) : null;
  const open = focused && key !== null && key !== dismissed;
  const query = token?.kind === "file" && open ? token.query : null;
  useLayoutEffect(() => {
    const pending = pendingCaret.current;
    if (pending?.text === draft) {
      pendingCaret.current = null;
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange?.(pending.caret, pending.caret);
      setCaret(pending.caret);
    }
  }, [draft, inputRef]);
  useEffect(() => { setSelected(0); }, [key]);
  useEffect(() => {
    if (query === null || !workingDirectory || !filesEnabled) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true); setError(null);
    const timer = setTimeout(() => {
      void searchProjectFiles(workingDirectory, query).then(result => {
        if (!cancelled) setFiles({ query, directory: workingDirectory, result });
      }, () => { if (!cancelled) setError(t("chat.assist.filesFailed")); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 120);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, workingDirectory, filesEnabled, t]);
  const matches = filesEnabled && token?.kind === "file" && files?.query === query && files.directory === workingDirectory ? files.result : null;
  const items: { id: string; label: string; description: string; disabled: boolean; choose: () => void }[] = token?.kind === "command"
    ? slashCommandIds.filter(command => command.startsWith(token.query)).map(command => ({
      id: command, label: "/" + command, description: t(`chat.command.${command}`), disabled: !commands[command],
      choose: () => {
        onText(draft.slice(token.end).trimStart()); setDismissed(key);
        commands[command]?.();
      },
    }))
    : (matches?.files ?? []).map(file => ({
      id: file.path, label: file.path, description: "", disabled: false,
      choose: () => {
        if (!token || !onFile(file)) return;
        const inserted = insertProjectMention(draft, token, file.path);
        pendingCaret.current = inserted; onText(inserted.text); setDismissed(key);
      },
    }));
  useEffect(() => {
    const menu = menuRef.current;
    const item = menu?.querySelector?.<HTMLElement>(`[data-index="${selected}"]`);
    if (menu && item) {
      if (item.offsetTop < menu.scrollTop) menu.scrollTop = item.offsetTop;
      else if (item.offsetTop + item.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = item.offsetTop + item.offsetHeight - menu.clientHeight;
    }
  }, [selected]);
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!open || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return false;
    if (event.key === "Escape") { event.preventDefault(); setDismissed(key); return true; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (items.length) setSelected(current => (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
      return true;
    }
    if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      const item = items[Math.min(selected, items.length - 1)];
      if (item) {
        event.preventDefault(); if (!item.disabled && !loading) item.choose(); return true;
      }
      if (event.key === "Enter") { event.preventDefault(); return true; }
    }
    return false;
  }
  return {
    select: (position: number) => setCaret(position), keyDown,
    dismiss: () => { setDismissed(key); setFocused(false); }, reopen: () => { setFocused(true); setDismissed(null); },
    inputProps: { "aria-autocomplete": "list" as const, "aria-controls": open ? id : undefined,
      "aria-activedescendant": open && items[selected] ? `${id}-${selected}` : undefined },
    menu: open && <div className="composer-assistance" ref={menuRef} id={id} role="listbox" aria-label={t(token?.kind === "file" ? "chat.assist.files" : "chat.assist.commands")}>
      {items.map((item, index) => <button type="button" role="option" id={`${id}-${index}`} key={item.id} data-index={index}
        aria-selected={selected === index} aria-disabled={item.disabled} className={selected === index ? "is-active" : undefined}
        onMouseDown={event => event.preventDefault()} onMouseEnter={() => setSelected(index)}
        onClick={() => { if (!item.disabled) item.choose(); }}>
        <strong>{item.label}</strong><small>{item.description}{item.disabled ? ` · ${t("chat.assist.unavailable")}` : ""}</small>
      </button>)}
      {token?.kind === "command" && items.length === 0 && <p role="status">{t("chat.assist.noCommands")}</p>}
      {token?.kind === "file" && <p role="status">{!filesEnabled ? t("chat.assist.noLocalTools") : !workingDirectory ? t("chat.assist.chooseDirectory") : loading ? t("common.loading") : error || (!items.length ? t("chat.assist.noFiles") : matches?.truncated ? t("chat.assist.truncated") : "")}</p>}
    </div>,
  };
}
