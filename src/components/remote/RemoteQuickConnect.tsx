import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { normalizeViewerPairingToken } from "../../app/pairingToken";
import {
  formatDeviceId,
  loadRelayAddress,
  normalizeDeviceId,
  saveRelayAddress,
} from "../../app/remoteRelay";
import type { RemoteApi } from "../../app/useRemoteSessions";
import { useI18n } from "../../i18n/context";
import { Callout } from "../common/Callout";
import { CheckIcon, CloseIcon, ScreenShareIcon, ShieldIcon } from "../icons";
import { useModalFocus } from "../overlays/modalFocus";
import { RelayAddressField } from "./RelayAddressField";

/**
 * AnyDesk-style entry: type the other machine's nine-digit device ID and its
 * pairing code, and the relay finds it — no IP address or port required.
 */
/** What a successful dial learned about the machine on the other end. */
export interface RemoteQuickConnectResult {
  sessionId: string;
  deviceId: string;
  relayAddress: string;
  /** The name the Agent reports, used when remembering the device. */
  agentName: string;
}

export function RemoteQuickConnect({
  remote,
  onConnected,
  onCancel,
}: {
  remote: RemoteApi;
  onConnected: (result: RemoteQuickConnectResult) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [savedRelay] = useState(() => loadRelayAddress(window.localStorage));
  const [relayAddress, setRelayAddress] = useState(savedRelay);
  const [deviceId, setDeviceId] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [legacyPairing, setLegacyPairing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const idRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useModalFocus({
    dialogRef,
    getInitialFocus: () => idRef.current,
    onEscape: onCancel,
    escapeDisabled: busy,
  });

  useEffect(() => {
    if (busy) dialogRef.current?.focus();
  }, [busy]);

  const normalizedToken = normalizeViewerPairingToken(pairingCode, true, legacyPairing);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedId = normalizeDeviceId(deviceId);
    if (!normalizedId) {
      setProblem(t("remote.quick.idInvalid"));
      return;
    }
    if (!normalizedToken) {
      setProblem(t("remote.connect.relayCodeInvalid"));
      return;
    }
    if (!relayAddress.trim()) {
      setProblem(t("remote.quick.relayMissing"));
      return;
    }
    setBusy(true);
    setProblem(null);
    const outcome = await remote.connect({
      profileId: `relay:${normalizedId}`,
      hostname: "",
      port: 0,
      pairingCode: normalizedToken,
      legacyPairing,
      deviceId: normalizedId,
      relayAddress: relayAddress.trim(),
    });
    // Drop the one-time secret immediately after the IPC call resolves.
    setPairingCode("");
    setBusy(false);
    if (outcome.outcome === "connected") {
      saveRelayAddress(window.localStorage, relayAddress);
      onConnected({
        sessionId: outcome.sessionId,
        deviceId: normalizedId,
        relayAddress: relayAddress.trim(),
        agentName: outcome.agentName,
      });
    } else {
      setProblem(
        outcome.stage === "legacyTrust" ? t("remote.connect.legacyUntrusted") :
        outcome.stage === "identityChanged" ? t("remote.connect.identityChanged") :
        t("remote.connect.failedBody", {
          stage: outcome.stage,
          detail: outcome.detail,
        }),
      );
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
        aria-labelledby="remote-quick-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog__head">
          <span className="dialog__icon dialog__icon--inline" aria-hidden="true">
            <ScreenShareIcon size={18} />
          </span>
          <h2 className="dialog__title" id="remote-quick-title">
            {t("remote.quick.title")}
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
          <Callout tone="security" title={t("remote.quick.securityTitle")}>
            {t("remote.quick.securityBody")}
          </Callout>
          {problem && (
            <Callout tone="warn" title={t("remote.connect.failedTitle")}>
              {problem}
            </Callout>
          )}

          <div className="field">
            <label className="field__label" htmlFor="remote-quick-id">
              {t("remote.quick.deviceId")}
            </label>
            <input
              id="remote-quick-id"
              ref={idRef}
              className="input mono remote-quick-id"
              value={formatDeviceId(deviceId)}
              inputMode="numeric"
              placeholder="000 000 000"
              disabled={busy}
              onChange={(event) =>
                setDeviceId(
                  event.currentTarget.value.replace(/\D/g, "").slice(0, 9),
                )
              }
            />
            <p className="field__optional">{t("remote.quick.deviceIdHint")}</p>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="remote-quick-code">
              {t("remote.connect.code")}
            </label>
            <div className="remote-code-field">
              <ShieldIcon size={16} />
              <input
                id="remote-quick-code"
                aria-describedby="remote-quick-code-hint"
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
            <p id="remote-quick-code-hint" className="field__optional">{t("remote.connect.relayCodeHint")}</p>
          </div>

          <label className="checkbox">
            <input type="checkbox" checked={legacyPairing} disabled={busy}
              onChange={(event) => setLegacyPairing(event.currentTarget.checked)} />
            <span className="checkbox__box" aria-hidden="true"><CheckIcon size={11} /></span>
            {t("remote.connect.legacyPairing")}
          </label>

          <RelayAddressField
            id="remote-quick-relay"
            value={relayAddress}
            hasSaved={!!savedRelay}
            busy={busy}
            hint={t("remote.quick.relayHint")}
            onChange={setRelayAddress}
          />

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
              {busy ? t("remote.connect.connecting") : t("remote.quick.submit")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
