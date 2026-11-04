import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { InfoIcon } from "../icons";

/** Optional context stays behind an explicit, keyboard-accessible help button. */
export function ConversationInfo({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      button.current?.focus();
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return <div ref={root} className="conversation-info">
    <button ref={button} type="button" className="icon-button" aria-label={label} title={label}
      aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}><InfoIcon /></button>
    {open && <div id={id} role="note" aria-label={label} className="conversation-info__content">{children}</div>}
  </div>;
}
