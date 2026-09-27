/**
 * Per-call approval for a command an AI wrote itself.
 *
 * The exact text is shown before anything runs, refusing is the default, and
 * walking away is a refusal too: the desktop drops the proposal when its own
 * deadline passes. "Always allow" is offered last, is remembered against the
 * saved connection only, and can be taken back in Settings.
 */

import { useEffect, useRef, useState } from "react";
import {
  QUIET_MINUTES,
  useRemoteCommandApprovals,
  type PendingRemoteCommand,
} from "../../app/useRemoteCommandApprovals";
import { useI18n } from "../../i18n/context";
import { AlertIcon } from "../icons";
import { useModalFocus } from "./modalFocus";

export function remainingSeconds(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

function ApprovalDialog({
  request,
  waiting,
  error,
  onDecide,
}: {
  request: PendingRemoteCommand;
  waiting: number;
  error?: string;
  onDecide: (approve: boolean, quietMinutes?: number, always?: boolean) => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const denyRef = useRef<HTMLButtonElement>(null);
  const [seconds, setSeconds] = useState(() =>
    remainingSeconds(Date.now() + request.expiresInMs, Date.now()),
  );

  useModalFocus({ dialogRef, getInitialFocus: () => denyRef.current, onEscape: () => onDecide(false) });

  useEffect(() => {
    denyRef.current?.focus();
    const deadline = Date.now() + request.expiresInMs;
    setSeconds(remainingSeconds(deadline, Date.now()));
    const timer = setInterval(() => setSeconds(remainingSeconds(deadline, Date.now())), 1000);
    return () => clearInterval(timer);
  }, [request.operationId, request.expiresInMs]);

  return (
    <div className="scrim scrim--top" role="presentation">
      <div
        ref={dialogRef}
        className="dialog dialog--wide"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="mcp-command-approval-title"
        tabIndex={-1}
      >
        <header className="dialog__head">
          <span className="dialog__icon dialog__icon--inline dialog__icon--danger" aria-hidden="true">
            <AlertIcon size={18} />
          </span>
          <h2 className="dialog__title" id="mcp-command-approval-title">
            {t("mcp.commandApproval.title")}
          </h2>
        </header>

        <div className="dialog__stack">
          <p className="dialog__body">
            <span className="eyebrow">{t("mcp.commandApproval.connection")}</span> {request.targetLabel}
          </p>
          <p className="dialog__body">
            <span className="eyebrow">{t("mcp.commandApproval.client")}</span> {request.client}
          </p>
          <p className="dialog__body">
            <span className="eyebrow">{t("mcp.commandApproval.command")}</span>
          </p>
          <p className="dialog__body mono">{request.command}</p>
          <p className="dialog__body">{t("mcp.commandApproval.warning")}</p>
          <p className="dialog__body">{t("mcp.commandApproval.expires", { seconds })}</p>
          {waiting > 0 && <p className="dialog__body">{t("mcp.commandApproval.queued", { count: waiting })}</p>}
          {error && <p className="dialog__body" role="alert">{t("mcp.commandApproval.alwaysFailed", { reason: error })}</p>}
        </div>

        <div className="dialog__actions">
          <button ref={denyRef} type="button" className="button button--primary" onClick={() => onDecide(false)}>
            {t("mcp.commandApproval.deny")}
          </button>
          <button type="button" className="button button--ghost button--danger" onClick={() => onDecide(true)}>
            {t("mcp.commandApproval.approve")}
          </button>
          <button
            type="button"
            className="button button--ghost button--danger"
            onClick={() => onDecide(true, QUIET_MINUTES)}
          >
            {t("mcp.commandApproval.approveQuiet", { minutes: QUIET_MINUTES })}
          </button>
          <button
            type="button"
            className="button button--ghost button--danger"
            onClick={() => onDecide(true, 0, true)}
          >
            {t("mcp.commandApproval.approveAlways")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function RemoteCommandApproval() {
  const { pending, decide } = useRemoteCommandApprovals();
  const [failure, setFailure] = useState<{ operationId: string; reason: string } | null>(null);
  const request = pending[0];
  if (!request) return null;
  return (
    <ApprovalDialog
      request={request}
      waiting={pending.length - 1}
      error={failure?.operationId === request.operationId ? failure.reason : undefined}
      onDecide={(approve, quietMinutes, always) => {
        setFailure(null);
        // A refused "always" leaves the proposal waiting; say why instead of
        // letting the card sit there as if the click never happened.
        decide(request.operationId, approve, quietMinutes, always).catch((reason: unknown) =>
          setFailure({ operationId: request.operationId, reason: String(reason) }),
        );
      }}
    />
  );
}
