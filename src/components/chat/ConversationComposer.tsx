import { useEffect, useRef, useState, type ReactNode } from "react";
import { displayPath } from "../../app/displayPath";
import { useI18n } from "../../i18n/context";
import { DesktopIcon, FileIcon, FolderIcon, ImageFileIcon, PlusIcon } from "../icons";

export function ConversationComposerFrame({ workingDirectory, children }: {
  workingDirectory: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return <div className="session-composer__frame">
    <div className="session-composer__context">
      {workingDirectory && <span className="session-composer__place" title={displayPath(workingDirectory)}>
        <FolderIcon size={14} />
        <span>{workingDirectory.split(/[\\/]/).filter(Boolean).pop() ?? workingDirectory}</span>
      </span>}
      <span className="session-composer__place">
        <DesktopIcon size={14} /><span>{t("chat.delegate.machine.local")}</span>
      </span>
    </div>
    {children}
  </div>;
}

export function ComposerPopover({ label, disabled, model = false, open, onOpenChange, children }: {
  label: string;
  disabled: boolean;
  model?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    if (disabled) { onOpenChange(false); return; }
    function close(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      onOpenChange(false);
      buttonRef.current?.focus();
    }
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open, disabled, onOpenChange]);
  return <div ref={rootRef} className={model ? "session-composer__model-picker" : "session-composer__more"}>
    <button ref={buttonRef} type="button" className={model ? "session-composer__model" : "session-composer__icon"}
      disabled={disabled} aria-haspopup="dialog" aria-expanded={open}
      aria-label={label} title={label} onClick={() => onOpenChange(!open)}>
      {model ? label : <PlusIcon />}
    </button>
    {open && !disabled && <div role="dialog" aria-label={label}
      className={model ? "session-composer__menu session-composer__model-options" : "session-composer__menu"}>
      {children}
    </div>}
  </div>;
}

export function ComposerAttachments({ disabled, onChoose, children }: {
  disabled: boolean;
  onChoose: (kind: "image" | "file") => void;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  function choose(kind: "image" | "file") {
    setOpen(false);
    onChoose(kind);
  }
  return <ComposerPopover label={t("sessionChat.more")} disabled={disabled} open={open} onOpenChange={setOpen}>
    <button type="button" onClick={() => choose("image")}><ImageFileIcon size={14} />{t("chat.attachment.images")}</button>
    <button type="button" onClick={() => choose("file")}><FileIcon size={14} />{t("chat.attachment.files")}</button>
    {children}
  </ComposerPopover>;
}
