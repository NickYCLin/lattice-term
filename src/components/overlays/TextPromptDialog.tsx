/**
 * A single text field asked in the app's own dialog.  `window.prompt` is
 * not a real prompt inside the desktop WebView (it returns at once), so
 * anything that needs a name goes through here.
 */

import { useRef, useState, type FormEvent } from "react";
import { EditIcon } from "../icons";
import { useModalFocus } from "./modalFocus";

export function TextPromptDialog({
  title,
  label,
  initialValue = "",
  placeholder,
  confirmLabel,
  cancelLabel,
  onSubmit,
  onCancel,
}: {
  title: string;
  label: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel: string;
  cancelLabel: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialValue);
  const [composing, setComposing] = useState(false);
  const trimmed = value.trim();

  useModalFocus({
    dialogRef,
    getInitialFocus: () => inputRef.current,
    onEscape: onCancel,
    escapeDisabled: composing,
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (trimmed && !composing) onSubmit(trimmed);
  }

  return (
    <div className="scrim scrim--center" role="presentation" onMouseDown={onCancel}>
      <form
        ref={dialogRef}
        className="dialog text-prompt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="text-prompt-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={submit}
        onKeyDown={event => {
          if (event.key === "Enter" && (composing || event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault();
        }}
      >
        <header className="dialog__head">
          <span className="dialog__icon dialog__icon--inline" aria-hidden="true">
            <EditIcon size={18} />
          </span>
          <h2 className="dialog__title" id="text-prompt-title">
            {title}
          </h2>
        </header>
        <label className="field" htmlFor="text-prompt-value">
          <span className="field__label">{label}</span>
          <input
            ref={inputRef}
            id="text-prompt-value"
            className="input"
            value={value}
            placeholder={placeholder}
            onChange={(event) => setValue(event.currentTarget.value)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            maxLength={255}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        <div className="dialog__actions">
          <button type="button" className="button button--ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="submit" className="button button--primary" disabled={!trimmed}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
