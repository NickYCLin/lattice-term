/**
 * Confirmation dialog for destructive actions.
 *
 * The confirm button always names the action and its object — "Delete Edge
 * gateway" — because a bare Yes/No does not tell the user what is about to
 * happen.
 */

import { useEffect, useRef, type ReactNode } from "react";
import { AlertIcon } from "../icons";
import { useModalFocus } from "./modalFocus";

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "danger",
  confirmDisabled = false,
  busy = false,
  children,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "danger" | "default";
  confirmDisabled?: boolean;
  busy?: boolean;
  /** Extra choices shown under the body, such as a sync checkbox. */
  children?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useModalFocus({
    dialogRef,
    getInitialFocus: () => cancelRef.current,
    onEscape: onCancel,
    escapeDisabled: busy,
  });

  useEffect(() => {
    (busy ? dialogRef : cancelRef).current?.focus();
  }, [busy]);

  return (
    <div
      className="scrim scrim--center"
      role="presentation"
      onMouseDown={() => {
        if (!busy) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-body"
        aria-busy={busy || undefined}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className={`dialog__icon dialog__icon--${tone}`} aria-hidden="true">
          <AlertIcon size={18} />
        </div>
        <h2 className="dialog__title" id="confirm-title">
          {title}
        </h2>
        <p className="dialog__body" id="confirm-body">
          {body}
        </p>
        {children}
        <div className="dialog__actions">
          <button
            type="button"
            ref={cancelRef}
            className="button button--ghost"
            disabled={busy}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`button ${tone === "danger" ? "button--danger" : "button--primary"}`}
            disabled={busy || confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
