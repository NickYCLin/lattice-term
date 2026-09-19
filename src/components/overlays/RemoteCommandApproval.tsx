/**
 * Per-call approval for a command an AI wrote itself.
 *
 * The exact text is shown before anything runs, refusing is the default, and
 * walking away is a refusal too: the desktop drops the proposal when its own
 * deadline passes. There is deliberately no "always allow" here.
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
  onDecide,
}: {
  request: PendingRemoteCommand;
  waiting: number;
  onDecide: (approve: boolean, quietMinutes?: number) => void;
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
        </div>
      </div>
    </div>
  );
}

export function RemoteCommandApproval() {
  const { pending, decide } = useRemoteCommandApprovals();
  const request = pending[0];
  if (!request) return null;
  return (
    <ApprovalDialog
      request={request}
      waiting={pending.length - 1}
      onDecide={(approve, quietMinutes) =>
        void decide(request.operationId, approve, quietMinutes)
      }
    />
  );
}
