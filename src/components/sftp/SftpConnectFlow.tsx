import { useEffect, useRef, useState, type FormEvent } from "react";
import type { SftpApi, SftpConnectOutcome } from "../../app/useSftpSessions";
import { useSavedCredential } from "../../app/useSavedCredential";
import {
  connectionTarget,
  type ConnectionProfile,
} from "../../domain/connection";
import type { HostFingerprint } from "../../domain/security";
import { useI18n, type MessageKey } from "../../i18n/context";
import { Callout } from "../common/Callout";
import {
  CheckIcon,
  CloseIcon,
  ShieldIcon,
  TransferIcon,
  TrashIcon,
} from "../icons";
import { HostFingerprintDialog } from "../overlays/HostFingerprintDialog";
import { HostKeyChangedDialog } from "../overlays/HostKeyChangedDialog";
import { useModalFocus } from "../overlays/modalFocus";

function presented(
  host: string,
  port: number,
  algorithm: string,
  fingerprint: string,
  seen?: { firstSeenAt: number; lastSeenAt: number },
): HostFingerprint {
  return {
    id: `${host}:${port}`,
    host,
    port,
    algorithm,
    fingerprint,
    firstSeenAt: seen?.firstSeenAt ?? 0,
    lastSeenAt: seen?.lastSeenAt ?? 0,
  };
}

type Phase =
  | { step: "password" }
  | { step: "connecting" }
  | {
      step: "unknownHost";
      outcome: Extract<SftpConnectOutcome, { outcome: "hostUnknown" }>;
    }
  | {
      step: "changedHost";
      outcome: Extract<SftpConnectOutcome, { outcome: "hostChanged" }>;
    };

function stageKey(stage: string): MessageKey {
  const known = [
    "connect",
    "authenticate",
    "channel",
    "subsystem",
    "directory",
    "registry",
    "trust",
    "invoke",
    "credential",
  ];
  return (
    known.includes(stage) ? `connect.stage.${stage}` : "connect.stage.connect"
  ) as MessageKey;
}

export function SftpConnectFlow({
  profile,
  sftp,
  onConnected,
  onCancel,
}: {
  profile: ConnectionProfile;
  sftp: SftpApi;
  onConnected: (sessionId: string) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const savedCredential = useSavedCredential(profile.id, "sftpPassword");
  const [phase, setPhase] = useState<Phase>({ step: "password" });
  const [password, setPassword] = useState("");
  const [useSavedPassword, setUseSavedPassword] = useState(false);
  const [rememberPassword, setRememberPassword] = useState(false);
  const [removingCredential, setRemovingCredential] = useState(false);
  const [problem, setProblem] = useState<{ title: string; body: string } | null>(
    null,
  );
  const passwordRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const busy = phase.step === "connecting";

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
  }, [phase.step, useSavedPassword]);

  useEffect(() => {
    if (busy) dialogRef.current?.focus();
  }, [busy]);

  async function attempt(secret: string) {
    setPhase({ step: "connecting" });
    setProblem(null);
    const outcome = await sftp.connect({
      profileId: profile.id,
      hostname: profile.hostname,
      port: profile.port,
      username: profile.username,
      auth: { kind: "password", password: useSavedPassword ? "" : secret },
      useSavedPassword,
      rememberPassword: !useSavedPassword && rememberPassword,
    });

    switch (outcome.outcome) {
      case "connected":
        setPassword("");
        onConnected(outcome.session.sessionId);
        return;
      case "hostUnknown":
        setPhase({ step: "unknownHost", outcome });
        return;
      case "hostChanged":
        setPhase({ step: "changedHost", outcome });
        return;
      case "authFailed":
        setPhase({ step: "password" });
        if (useSavedPassword) setUseSavedPassword(false);
        setProblem({
          title: t("connect.failed.title"),
          body: t("connect.authFailed"),
        });
        return;
      default:
        setPhase({ step: "password" });
        setProblem({
          title: t("connect.failed.title"),
          body: t("connect.failed.body", {
            stage: t(stageKey(outcome.stage)),
            detail: outcome.detail,
          }),
        });
    }
  }

  async function removeSavedCredential() {
    setRemovingCredential(true);
    setProblem(null);
    try {
      await savedCredential.remove();
      setUseSavedPassword(false);
    } catch (reason) {
      setProblem({
        title: t("credential.removeFailed.title"),
        body: reason instanceof Error ? reason.message : String(reason),
      });
    } finally {
      setRemovingCredential(false);
    }
  }

  async function trustAndConnect(
    host: string,
    port: number,
    algorithm: string,
    fingerprint: string,
  ) {
    try {
      await sftp.trustHost(host, port, algorithm, fingerprint);
    } catch (reason) {
      setPhase({ step: "password" });
      setProblem({
        title: t("connect.failed.title"),
        body: t("connect.failed.body", {
          stage: t(stageKey("trust")),
          detail: reason instanceof Error ? reason.message : String(reason),
        }),
      });
      return;
    }
    await attempt(password);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile.username.trim()) {
      setProblem({
        title: t("connect.failed.title"),
        body: t("connect.noUsername"),
      });
      return;
    }
    void attempt(password);
  }

  if (phase.step === "unknownHost") {
    const { host, port, algorithm, fingerprint } = phase.outcome;
    return (
      <HostFingerprintDialog
        fingerprint={presented(host, port, algorithm, fingerprint)}
        onTrustAndSave={() => trustAndConnect(host, port, algorithm, fingerprint)}
        onCancel={onCancel}
      />
    );
  }

  if (phase.step === "changedHost") {
    const { host, port, algorithm, receivedFingerprint, expected } =
      phase.outcome;
    return (
      <HostKeyChangedDialog
        host={host}
        port={port}
        expectedFingerprint={presented(
          host,
          port,
          expected.algorithm,
          expected.fingerprint,
          {
            firstSeenAt: expected.firstTrustedAt,
            lastSeenAt: expected.lastSeenAt,
          },
        )}
        receivedFingerprint={presented(
          host,
          port,
          algorithm,
          receivedFingerprint,
        )}
        onAbort={onCancel}
        onAcceptRiskAndReplace={() =>
          trustAndConnect(host, port, algorithm, receivedFingerprint)
        }
      />
    );
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
        aria-labelledby="sftp-connect-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog__head">
          <span className="dialog__icon dialog__icon--inline" aria-hidden="true">
            <TransferIcon size={18} />
          </span>
          <h2 className="dialog__title" id="sftp-connect-title">
            {t("connect.title", { name: profile.name })}
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
          {problem && (
            <Callout tone="warn" title={problem.title}>
              {problem.body}
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
              <label className="field__label" htmlFor="sftp-connect-password">
                {t("connect.password")}
              </label>
              <input
                id="sftp-connect-password"
                ref={passwordRef}
                className="input"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.currentTarget.value)}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
              />
              <p className="field__optional">{t("connect.passwordHint")}</p>
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
            <button
              type="submit"
              className="button button--primary"
              disabled={busy}
            >
              {busy ? t("connect.connecting") : t("connect.submit")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
