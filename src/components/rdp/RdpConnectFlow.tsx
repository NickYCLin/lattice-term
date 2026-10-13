import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { RdpApi } from "../../app/useRdpSessions";
import { useSavedCredential } from "../../app/useSavedCredential";
import { rdpCredentialFailure } from "../../app/rdpCredentialFailure";
import { connectionTarget, type ConnectionProfile } from "../../domain/connection";
import { useI18n } from "../../i18n/context";
import { Callout } from "../common/Callout";
import { CheckIcon, CloseIcon, ScreenShareIcon, ShieldIcon, TrashIcon } from "../icons";
import { useModalFocus } from "../overlays/modalFocus";

export function RdpConnectFlow({
  profile,
  rdp,
  onConnected,
  onCancel,
}: {
  profile: ConnectionProfile;
  rdp: RdpApi;
  onConnected: (sessionId: string) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const savedCredential = useSavedCredential(profile.id, "rdpPassword");
  const [password, setPassword] = useState("");
  const [useSavedPassword, setUseSavedPassword] = useState(false);
  const [rememberPassword, setRememberPassword] = useState(false);
  const [removingCredential, setRemovingCredential] = useState(false);
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useModalFocus({
    dialogRef,
    getInitialFocus: () => passwordRef.current,
    onEscape: onCancel,
    escapeDisabled: busy,
  });

  useEffect(() => {
    if (savedCredential.state.mode === "saved") {
      setUseSavedPassword(true);
    } else if (savedCredential.state.mode !== "loading") {
      setUseSavedPassword(false);
    }
  }, [savedCredential.state.mode]);

  useEffect(() => {
    if (!useSavedPassword) passwordRef.current?.focus();
  }, [useSavedPassword]);
  useEffect(() => {
    if (busy) dialogRef.current?.focus();
  }, [busy]);

  async function attempt() {
    if (!profile.username.trim()) {
      setProblem(t("rdp.connect.noUsername"));
      return;
    }
    setBusy(true);
    setProblem(null);
    const outcome = await rdp.connect({
      profileId: profile.id,
      hostname: profile.hostname,
      port: profile.port,
      username: profile.username,
      password: useSavedPassword ? "" : password,
      useSavedPassword,
      rememberPassword: !useSavedPassword && rememberPassword,
      domain: domain.trim() || undefined,
      width: 1280,
      height: 720,
    });
    setBusy(false);
    if (outcome.outcome === "connected") {
      setPassword("");
      onConnected(outcome.sessionId);
    } else {
      const credentialFailure = rdpCredentialFailure(outcome.detail);
      if ((outcome.stage === "credential" || credentialFailure) && useSavedPassword) {
        setUseSavedPassword(false);
      }
      setProblem(
        (credentialFailure ? t(`rdp.connect.${credentialFailure}`) + "\n\n" : "") + t("rdp.connect.failedBody", {
          stage: outcome.stage,
          detail: outcome.detail,
        }),
      );
    }
  }

  async function removeSavedCredential() {
    setRemovingCredential(true);
    setProblem(null);
    try {
      await savedCredential.remove();
      setUseSavedPassword(false);
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

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void attempt();
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
        aria-labelledby="rdp-connect-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog__head">
          <span className="dialog__icon dialog__icon--inline" aria-hidden="true">
            <ScreenShareIcon size={18} />
          </span>
          <h2 className="dialog__title" id="rdp-connect-title">
            {t("rdp.connect.title", { name: profile.name })}
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
          <Callout tone="security" title={t("rdp.connect.securityTitle")}>
            {t("rdp.connect.securityBody")}
          </Callout>
          {problem && (
            <Callout tone="warn" title={t("rdp.connect.failedTitle")}>
              {problem}
            </Callout>
          )}
          {savedCredential.state.mode === "saved" && (
            <Callout tone="security" title={t("credential.saved.title")}>
              <div className="credential-choice">
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={useSavedPassword}
                    disabled={busy || removingCredential}
                    onChange={(event) =>
                      setUseSavedPassword(event.currentTarget.checked)
                    }
                  />
                  <span className="checkbox__box" aria-hidden="true">
                    <CheckIcon size={11} />
                  </span>
                  {t("credential.useSaved", {
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
                    : t("credential.remove")}
                </button>
              </div>
            </Callout>
          )}

          {savedCredential.state.mode === "unavailable" && (
            <Callout tone="warn" title={t("credential.unavailable.title")}>
              {t(
                savedCredential.state.runtimeUnavailable
                  ? "credential.unavailable.browserBody"
                  : "credential.unavailable.body",
                { detail: savedCredential.state.detail },
              )}
            </Callout>
          )}

          <div className="field-grid field-grid--even">
            {!useSavedPassword && (
              <div className="field">
                <label className="field__label" htmlFor="rdp-password">
                  {t("rdp.connect.password")}
                </label>
                <input
                  id="rdp-password"
                  ref={passwordRef}
                  className="input"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  disabled={busy}
                  onChange={(event) => setPassword(event.currentTarget.value)}
                />
              </div>
            )}
            <div className="field">
              <label className="field__label" htmlFor="rdp-domain">
                {t("rdp.connect.domain")}
              </label>
              <input
                id="rdp-domain"
                className="input"
                value={domain}
                disabled={busy}
                placeholder={t("rdp.connect.domainPlaceholder")}
                onChange={(event) => setDomain(event.currentTarget.value)}
              />
            </div>
          </div>

          {!useSavedPassword && (savedCredential.state.mode === "missing" || savedCredential.state.mode === "saved") && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={rememberPassword}
                disabled={busy || password.length === 0}
                onChange={(event) =>
                  setRememberPassword(event.currentTarget.checked)
                }
              />
              <span className="checkbox__box" aria-hidden="true">
                <CheckIcon size={11} />
              </span>
              <ShieldIcon size={13} />
              {t(savedCredential.state.mode === "saved" ? "rdp.connect.replaceSavedPassword" : "credential.remember", {
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
              <ShieldIcon size={14} />
              {busy ? t("rdp.connect.connecting") : t("rdp.connect.submit")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
