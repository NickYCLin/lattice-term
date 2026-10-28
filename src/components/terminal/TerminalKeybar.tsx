import { useRef, useState } from "react";
import { useI18n } from "../../i18n/context";
import { KeyboardIcon } from "../icons";

export function useTerminalControlKey() {
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);
  function toggle() {
    armedRef.current = !armedRef.current;
    setArmed(armedRef.current);
  }
  function consume(data: string): string {
    if (!armedRef.current || data.length !== 1) return data;
    armedRef.current = false;
    setArmed(false);
    const code = data.toUpperCase().charCodeAt(0);
    return code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : data;
  }
  return { armed, toggle, consume };
}

const keys = [
  { label: "Enter", sequence: "\r" },
  { label: "Esc", sequence: "\x1b" },
  { label: "Tab", sequence: "\t" },
  { label: "\u2191", sequence: "\x1b[A" },
  { label: "\u2193", sequence: "\x1b[B" },
  { label: "\u2190", sequence: "\x1b[D" },
  { label: "\u2192", sequence: "\x1b[C" },
  { label: "Home", sequence: "\x1b[H" },
  { label: "End", sequence: "\x1b[F" },
  { label: "PgUp", sequence: "\x1b[5~" },
  { label: "PgDn", sequence: "\x1b[6~" },
  { label: "Del", sequence: "\x1b[3~" },
  { label: "|", sequence: "|" },
  { label: "-", sequence: "-" },
  { label: "~", sequence: "~" },
];

export function TerminalKeybar({
  ctrlArmed, onToggleCtrl, onToggleKeyboard, onInput,
}: {
  ctrlArmed: boolean;
  onToggleCtrl: () => void;
  onToggleKeyboard: () => void;
  onInput: (sequence: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="terminal-keybar" role="toolbar" aria-label={t("terminal.keybar.label")}
      onPointerDown={(event) => event.preventDefault()}>
      <button type="button" className="terminal-keybar__key terminal-keybar__keyboard"
        aria-label={t("terminal.keybar.keyboard")} onClick={onToggleKeyboard}>
        <KeyboardIcon size={18} />
      </button>
      <button type="button" className={"terminal-keybar__key" + (ctrlArmed ? " is-armed" : "")}
        aria-pressed={ctrlArmed} onClick={onToggleCtrl}>
        {t("terminal.keybar.ctrl")}
      </button>
      {keys.map((key) => (
        <button key={key.label} type="button" className="terminal-keybar__key"
          onClick={() => onInput(key.sequence)}>{key.label}</button>
      ))}
    </div>
  );
}
