import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { normalizeViewerPairingToken } from "../../app/pairingToken";
import { relayConnectFollowUp } from "../../app/relayAddressRecovery";
import type { RemoteApi } from "../../app/useRemoteSessions";
import { useSavedCredential } from "../../app/useSavedCredential";
import {
  connectionTarget,
  isRelayProfile,
  type ConnectionProfile,
} from "../../domain/connection";
import { useI18n } from "../../i18n/context";
import { Callout } from "../common/Callout";
import {
  CheckIcon,
  CloseIcon,
  ScreenShareIcon,
  ShieldIcon,
  TrashIcon,
} from "../icons";
import { useModalFocus } from "../overlays/modalFocus";

export function RemoteConnectFlow({
  profile,
  remote,
  onConnected,
  onRelayAddressChanged,
  onCancel,
}: {
  profile: ConnectionProfile;
  remote: RemoteApi;
  onConnected: (sessionId: string) => void;
  /** Persists a corrected relay address back onto the saved entry. */
  onRelayAddressChanged?: (relayAddress: string) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const relay = isRelayProfile(profile);
  const savedCredential = useSavedCredential(profile.id, "latticePairingCode");
  const [pairingCode, setPairingCode] = useState("");
  const [useSavedPairingCode, setUseSavedPairingCode] = useState(false);
  const [rememberPairingCode, setRememberPairingCode] = useState(false);
  const [legacyPairing, setLegacyPairing] = useState(false);
  const [removingCredential, setRemovingCredential] = useState(false);
  const [relayAddress, setRelayAddress] = useState(profile.relayAddress ?? "");
  // A quick tunnel hands out a new hostname every restart, so a saved address
  // goes stale on its own. Offering the field only after the relay actually
  // failed keeps the usual connection down to one input.
  const [relayUnreachable, setRelayUnreachable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const relayRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useModalFocus({
    dialogRef,
    getInitialFocus: () => codeRef.current,
    onEscape: onCancel,
    escapeDisabled: busy,
  });

  useEffect(() => {
    if (busy) dialogRef.current?.focus();
  }, [busy]);

  useEffect(() => {
    if (relay && savedCredential.state.mode === "saved") {
      setUseSavedPairingCode(true);
    } else if (savedCredential.state.mode !== "loading") {
      setUseSavedPairingCode(false);
    }
  }, [relay, savedCredential.state.mode]);

  useEffect(() => {
    if (!useSavedPairingCode) codeRef.current?.focus();
  }, [useSavedPairingCode]);

  // Once the address is the thing to fix, put the caret there rather than
  // leaving it in the pairing code the user already filled in correctly.
  useEffect(() => {
    if (relayUnreachable) relayRef.current?.focus();
  }, [relayUnreachable]);

  const normalizedToken = normalizeViewerPairingToken(pairingCode, relay, legacyPairing);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!useSavedPairingCode && !normalizedToken) {
      setProblem(t(relay ? "remote.connect.relayCodeInvalid" : "remote.connect.codeInvalid"));
      return;
    }
    setBusy(true);
    setProblem(null);
    const attempted = relayAddress.trim();
    const outcome = await remote.connect({
      profileId: profile.id,
      hostname: profile.hostname,
      port: profile.port,
      pairingCode: useSavedPairingCode ? "" : normalizedToken!,
      useSavedPairingCode,
      legacyPairing,
      rememberPairingCode:
        relay && !useSavedPairingCode && rememberPairingCode,
      // A remembered device has no address of its own; the relay finds it by
      // identity, exactly as the connect-by-ID dialog does.
      ...(relay ? { deviceId: profile.deviceId, relayAddress: attempted } : {}),
    });
    // Drop the one-time secret immediately after the IPC call resolves.
    setPairingCode("");
    setBusy(false);

    const followUp = relayConnectFollowUp({
      relayEntry: relay,
      savedAddress: profile.relayAddress ?? "",
      attemptedAddress: attempted,
      outcome,
    });
    if (followUp.addressToSave) onRelayAddressChanged?.(followUp.addressToSave);

    if (outcome.outcome === "connected") {
      onConnected(outcome.sessionId);
      return;
    }
    if (
      useSavedPairingCode &&
      (outcome.stage === "credential" || outcome.stage === "pairing")
    ) {
      setUseSavedPairingCode(false);
    }
    if (followUp.offerAddressRepair) setRelayUnreachable(true);
    setProblem(
      outcome.stage === "legacyTrust" ? t("remote.connect.legacyUntrusted") :
      outcome.stage === "identityChanged" ? t("remote.connect.identityChanged") :
      t("remote.connect.failedBody", {
        stage: outcome.stage,
        detail: outcome.detail,
      }),
    );
  }

  async function removeSavedCredential() {
    setRemovingCredential(true);
    setProblem(null);
    try {
      await savedCredential.remove();
      setUseSavedPairingCode(false);
    } catch (reason) {
      setProblem(
        t("credential.removeFailed.body", {
          detail: reason instanceof Error ? reason.message : String(reason),
        }),
      );
    } finally {
      setRemovingCredential(false);
    }
  }

  return (
    <div
      className="scrim scrim--center"
      role="presentation"
      onMouseDown={busy ? undefined : onCancel}
    >
      <div
        ref={dialogRef}
        className="dialog dialog--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-connect-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog__head">
          <span className="dialog__icon dialog__icon--inline" aria-hidden="true">
            <ScreenShareIcon size={18} />
          </span>
          <h2 className="dialog__title" id="remote-connect-title">
            {t("remote.connect.title", { name: profile.name })}
          </h2>
          <button
            type="button"
            className="icon-button icon-button--sm"
            onClick={onCancel}
            disabled={busy}
            aria-label={t("common.close")}
            style={{ marginLeft: "auto" }}
          >
            <CloseIcon size={14} />
          </button>
        </header>

        <form className="dialog__stack" onSubmit={submit}>
          <p className="dialog__body mono">{connectionTarget(profile)}</p>
          <Callout tone="security" title={t("remote.connect.securityTitle")}>
            {t("remote.connect.securityBody")}
          </Callout>
          {problem && (
            <Callout tone="warn" title={t("remote.connect.failedTitle")}>
              {problem}
            </Callout>
          )}

          {relay && savedCredential.state.mode === "saved" && (
            <Callout tone="security" title={t("remote.connect.savedCodeTitle")}>
              <div className="credential-choice">
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={useSavedPairingCode}
                    disabled={busy || removingCredential}
                    onChange={(event) =>
                      setUseSavedPairingCode(event.currentTarget.checked)
                    }
                  />
                  <span className="checkbox__box" aria-hidden="true">
                    <CheckIcon size={11} />
                  </span>
                  {t("remote.connect.useSavedCode", {
                    provider: savedCredential.state.provider,
                  })}
                </label>
                <button
                  type="button"
                  className="button button--ghost button--sm"
                  disabled={busy || removingCredential}
                  onClick={() => void removeSavedCredential()}
                >
                  <TrashIcon size={13} />
                  {removingCredential
                    ? t("credential.removing")
                    : t("remote.connect.removeSavedCode")}
                </button>
              </div>
            </Callout>
          )}

          {relay && savedCredential.state.mode === "unavailable" && (
            <Callout tone="warn" title={t("credential.unavailable.title")}>
              {t(
                savedCredential.state.runtimeUnavailable
                  ? "credential.unavailable.browserBody"
                  : "credential.unavailable.body",
                { detail: savedCredential.state.detail },
              )}
            </Callout>
          )}

          {relayUnreachable && (
            <div className="field">
              <Callout tone="info" title={t("remote.connect.relayMovedTitle")}>
                {t("remote.connect.relayMovedBody")}
              </Callout>
              <label className="field__label" htmlFor="remote-relay-address">
                {t("remote.host.relayAddress")}
              </label>
              <input
                id="remote-relay-address"
                ref={relayRef}
                className="input mono"
                value={relayAddress}
                disabled={busy}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                onChange={(event) => setRelayAddress(event.currentTarget.value)}
              />
              <p className="field__optional">{t("remote.host.relayHint")}</p>
            </div>
          )}

          {!useSavedPairingCode && (
            <div className="field">
              <label className="field__label" htmlFor="remote-pairing-code">
                {t("remote.connect.code")}
              </label>
              <div className="remote-code-field">
                <ShieldIcon size={16} />
                <input
                  id="remote-pairing-code"
                  aria-describedby="remote-pairing-code-hint"
                  ref={codeRef}
                  className="input mono"
                  value={pairingCode}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={64}
                  disabled={busy}
                  onChange={(event) =>
                    setPairingCode(event.currentTarget.value)
                  }
                />
              </div>
              <p id="remote-pairing-code-hint" className="field__optional">{t(relay ? "remote.connect.relayCodeHint" : "remote.connect.codeHint")}</p>
            </div>
          )}

          <label className="checkbox">
            <input type="checkbox" checked={legacyPairing} disabled={busy}
              onChange={(event) => setLegacyPairing(event.currentTarget.checked)} />
            <span className="checkbox__box" aria-hidden="true"><CheckIcon size={11} /></span>
            {t("remote.connect.legacyPairing")}
          </label>

          {relay &&
            !useSavedPairingCode &&
            savedCredential.state.mode === "missing" && (
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={rememberPairingCode}
                  disabled={busy || !normalizedToken}
                  onChange={(event) =>
                    setRememberPairingCode(event.currentTarget.checked)
                  }
                />
                <span className="checkbox__box" aria-hidden="true">
                  <CheckIcon size={11} />
                </span>
                <ShieldIcon size={13} />
                {t("remote.connect.rememberCode", {
                  provider: savedCredential.state.provider,
                })}
              </label>
            )}

          <div className="dialog__actions">
            <button
              type="button"
              className="button button--ghost"
              onClick={onCancel}
              disabled={busy}
            >
              {t("common.cancel")}
            </button>
            <button type="submit" className="button button--primary" disabled={busy}>
              {busy ? t("remote.connect.connecting") : t("remote.connect.submit")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
