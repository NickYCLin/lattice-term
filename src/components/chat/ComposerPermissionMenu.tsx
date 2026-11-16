import { useState } from "react";
import type { ChatPermission } from "../../app/agentChat";
import { useI18n } from "../../i18n/context";
import { AlertIcon, ChevronDownIcon, ShieldIcon } from "../icons";
import { ComposerMenu } from "./ComposerMenu";

export function ComposerPermissionMenu({ value, options, disabled, onChange }: {
  value: ChatPermission; options: { value: ChatPermission; label: string; description: string }[];
  disabled: boolean; onChange: (value: ChatPermission) => void;
}) {
  const { t } = useI18n(); const [open, setOpen] = useState(false);
  const selected = options.find(option => option.value === value);
  return <ComposerMenu label={`${t("chat.permission")}：${selected?.label ?? value}`} open={open} onOpenChange={setOpen} disabled={disabled}
    className={`session-composer__access session-composer__access--editable${value === "full" ? " is-full" : " is-sandboxed"}`}
    trigger={<>{value === "full" ? <AlertIcon size={14} /> : <ShieldIcon size={14} />}<span>{selected?.label}</span><ChevronDownIcon size={12} /></>}>
    {close => options.map(option => <button key={option.value} type="button" role="menuitemradio" aria-checked={option.value === value}
      className="composer-menu__item" onClick={() => { close(); onChange(option.value); }}>
      <span>{option.label}</span><small>{option.description}</small>
    </button>)}
  </ComposerMenu>;
}
