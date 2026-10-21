import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { VncApi } from "../../app/useVncSessions";
import { useSavedCredential } from "../../app/useSavedCredential";
import { connectionTarget, type ConnectionProfile } from "../../domain/connection";
import { useI18n } from "../../i18n/context";
import { Callout } from "../common/Callout";
import { CheckIcon, CloseIcon, ScreenShareIcon, ShieldIcon, TrashIcon } from "../icons";
import { useModalFocus } from "../overlays/modalFocus";

export function VncConnectFlow({
  profile,
  vnc,
  onConnected,
  onCancel,
}: {
  profile: ConnectionProfile;
  vnc: VncApi;
  onConnected: (sessionId: string) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const savedCredential = useSavedCredential(profile.id, "vncPassword");
  const [password, setPassword] = useState("");
  const [useSavedPassword, setUseSavedPassword] = useState(false);
  const [rememberPassword, setRememberPassword] = useState(false);
  const [removingCredential, setRemovingCredential] = useState(false);
  const [connecting, setBusy] = useState(false);
  const busy = connecting || removingCredential;
  const [problem, setProblem] = useState<string | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const operationInFlight = useRef(false);

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
    if (operationInFlight.current) return;
    operationInFlight.current = true;
    try {
      setBusy(true);
      setProblem(null);
      const outcome = await vnc.connect({
        profileId: profile.id,
        hostname: profile.hostname,
        port: profile.port,
        password: useSavedPassword ? "" : password,
        useSavedPassword,
        rememberPassword: !useSavedPassword && rememberPassword,
      });
      if (outcome.outcome === "connected") {
        setPassword("");
        onConnected(outcome.sessionId);
      } else if (outcome.outcome === "authFailed") {
        if (useSavedPassword) setUseSavedPassword(false);
        setProblem(t("vnc.connect.authFailed"));
      } else {
        if (outcome.stage === "credential" && useSavedPassword) {
          setUseSavedPassword(false);
        }
        setProblem(
          t("vnc.connect.failedBody", {
            stage: outcome.stage,
            detail: outcome.detail,
          }),
        );
      }
    } catch (reason) {
      setProblem(t("vnc.connect.failedBody", {
        stage: "invoke",
        detail: reason instanceof Error ? reason.message : String(reason),
      }));
    } finally {
      operationInFlight.current = false;
      setBusy(false);
    }
  }

  async function removeSavedCredential() {
    if (operationInFlight.current) return;
    operationInFlight.current = true;
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
      operationInFlight.current = false;
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
        aria-labelledby="vnc-connect-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog__head">
          <span className="dialog__icon dialog__icon--inline" aria-hidden="true">
            <ScreenShareIcon size={18} />
          </span>
          <h2 className="dialog__title" id="vnc-connect-title">
            {t("vnc.connect.title", { name: profile.name })}
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
          {/* Classic VNC ships no transport encryption; saying so beats
              implying a safety that is not there. */}
          <Callout tone="warn" title={t("vnc.connect.securityTitle")}>
            {t("vnc.connect.securityBody")}
          </Callout>
          {problem && (
            <Callout tone="warn" title={t("vnc.connect.failedTitle")}>
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

          {!useSavedPassword && (
            <div className="field">
              <label className="field__label" htmlFor="vnc-password">
                {t("vnc.connect.password")}
              </label>
              <input
                id="vnc-password"
                ref={passwordRef}
                className="input"
                type="password"
                autoComplete="current-password"
                value={password}
                disabled={busy}
                onChange={(event) => setPassword(event.currentTarget.value)}
              />
              <p className="field__optional">{t("vnc.connect.passwordHint")}</p>
            </div>
          )}

          {!useSavedPassword && savedCredential.state.mode === "missing" && (
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
              {t("credential.remember", {
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
              <ScreenShareIcon size={14} />
              {connecting ? t("vnc.connect.connecting") : t("vnc.connect.submit")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
