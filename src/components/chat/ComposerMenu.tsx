import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { menuNavigationIndex } from "../overlays/menuNavigation";

export function composerMenuPosition(bounds: { left: number; top: number; bottom: number }, width: number, height: number, viewport: { width: number; height: number }) {
  const menuWidth = Math.min(width, Math.max(0, viewport.width - 16));
  const menuHeight = Math.min(height, Math.max(0, viewport.height - 16));
  const below = bounds.bottom + 6;
  return { left: Math.max(8, Math.min(bounds.left, viewport.width - menuWidth - 8)),
    top: Math.max(8, Math.min(below + menuHeight <= viewport.height - 8 ? below : bounds.top - menuHeight - 6, viewport.height - menuHeight - 8)),
    width: menuWidth, maxHeight: Math.max(0, viewport.height - 16) };
}
/** Portal-backed composer menu, sharing the app's vertical menu navigation rules. */
export function ComposerMenu({ label, trigger, className, disabled, open, onOpenChange, searchable = false, children }: {
  label: string; trigger: ReactNode; className: string; disabled: boolean; open: boolean;
  onOpenChange: (open: boolean) => void; searchable?: boolean; children: (close: () => void) => ReactNode;
}) {
  const id = useId(), anchor = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 8, width: 320, maxHeight: 320 });
  const close = (focus = true) => { onOpenChange(false); if (focus) anchor.current?.focus(); };
  function place() {
    const bounds = anchor.current?.getBoundingClientRect();
    if (bounds) setPosition(composerMenuPosition(bounds, 360, menu.current?.getBoundingClientRect().height ?? 320, { width: window.innerWidth, height: window.innerHeight }));
  }
  useLayoutEffect(() => {
    if (!open || disabled) return;
    place();
    const target = menu.current?.querySelector<HTMLElement>('input, button[aria-checked="true"]:not(:disabled)')
      ?? menu.current?.querySelector<HTMLElement>('button[role^="menuitem"]:not(:disabled)');
    (target ?? menu.current)?.focus();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(place);
    if (menu.current) observer?.observe(menu.current);
    return () => observer?.disconnect();
  }, [open, disabled]);
  useEffect(() => {
    if (!open) return;
    if (disabled) { onOpenChange(false); return; }
    const outside = (event: PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { document.removeEventListener("pointerdown", outside, true); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, disabled, onOpenChange]);
  return <><button ref={anchor} type="button" className={className} disabled={disabled} aria-label={label}
    aria-haspopup={searchable ? "dialog" : "menu"} aria-expanded={open} aria-controls={open ? id : undefined}
    onClick={() => open ? close() : onOpenChange(true)} onKeyDown={event => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); onOpenChange(true); }
    }}>{trigger}</button>
    {open && !disabled && createPortal(<div ref={menu} id={id} className="composer-menu" role={searchable ? "dialog" : "menu"} tabIndex={-1}
      aria-label={label} style={position} onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Tab") { close(); return; }
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
        if ((event.target as HTMLElement).tagName === "INPUT" && event.key !== "ArrowDown") return;
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]:not(:disabled)'));
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        if ((event.key === "Enter" || event.key === " ") && index >= 0) { event.preventDefault(); items[index].click(); return; }
        const next = index < 0 && event.key === "ArrowDown" ? 0 : menuNavigationIndex(event.key, index, items.length);
        if (next !== null) { event.preventDefault(); items[next]?.focus(); }
      }}>{children(() => close())}</div>, document.body)}
  </>;
}
