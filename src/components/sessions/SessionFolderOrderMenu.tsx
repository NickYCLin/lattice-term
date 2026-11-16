import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { sessionSidebarStepPlacement, type SessionSidebarFolder, type SessionSidebarLayout } from "../../app/sessionSidebarLayout";
import { useI18n } from "../../i18n/context";
import { MoreIcon } from "../icons";
import { handleMenuNavigation } from "../overlays/menuNavigation";

export function SessionFolderOrderMenu({ folder, layout, onMove }: {
  folder: SessionSidebarFolder; layout: SessionSidebarLayout;
  onMove: (nodeId: string, parentId: string | null, beforeNodeId?: string | null) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const anchor = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  function close() { setOpen(false); anchor.current?.focus(); }
  function place() {
    const bounds = anchor.current?.getBoundingClientRect();
    if (bounds) setPosition({ left: Math.max(8, Math.min(bounds.left, window.innerWidth - 248)), top: Math.max(8, Math.min(bounds.bottom + 4, window.innerHeight - 128)) });
  }
  useLayoutEffect(() => {
    if (!open) return;
    place();
    const first = menu.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)');
    (first ?? menu.current)?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && (anchor.current?.contains(event.target) || menu.current?.contains(event.target))) return;
      close();
    }
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { document.removeEventListener("pointerdown", outside, true); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
  return <><button type="button" className="icon-button icon-button--sm" data-tree-action="true"
    ref={anchor} aria-label={t("terminal.projects.folderOrder", { name: folder.name })} title={t("terminal.projects.folderOrder", { name: folder.name })}
    aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
    onClick={() => { if (open) close(); else setOpen(true); }} onKeyDown={event => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); }
    }}><MoreIcon size={11} /></button>
    {open && createPortal(<div id={id} ref={menu} role="menu" tabIndex={-1} aria-label={t("terminal.projects.folderOrder", { name: folder.name })}
      className="session-tree__order-menu" style={position} onKeyDown={event => handleMenuNavigation(event, close)}>
      {(["up", "down"] as const).map(direction => {
        const placement = sessionSidebarStepPlacement(layout, folder.id, direction);
        return <button type="button" role="menuitem" className="button button--ghost button--sm" key={direction} disabled={!placement}
          onClick={() => { if (!placement) return; close(); onMove(folder.id, placement.parentId, placement.beforeNodeId); }}>
          {t(direction === "up" ? "agents.workspace.moveUp" : "agents.workspace.moveDown", { name: folder.name })}
        </button>;
      })}
    </div>, document.body)}
  </>;
}
