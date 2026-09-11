/**
 * Everything between pressing Connect and having a terminal.
 *
 * The backend refuses to open a session for a host it does not already trust,
 * so this component drives the conversation that resolves that: collect the
 * credentials — a password, or a private key with an optional passphrase —
 * attempt the connection, and if the host key is unknown put the fingerprint
 * in front of the user before trying again. A key that has *changed* ends the
 * attempt — that decision is deliberately not one click away.
 *
 * The chosen method and key path are remembered per connection (never the
 * passphrase), so the next connect starts where the last one succeeded.
 */

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  connectionTarget,
  type ConnectionProfile,
} from "../../domain/connection";
import type { ConnectOutcome, SshApi } from "../../app/useSshSessions";
import { useI18n } from "../../i18n/context";
import type { MessageKey } from "../../i18n/context";
import { Callout } from "../common/Callout";
import { HostFingerprintDialog } from "../overlays/HostFingerprintDialog";
import { HostKeyChangedDialog } from "../overlays/HostKeyChangedDialog";
import { useModalFocus } from "../overlays/modalFocus";
import {
  CheckIcon,
  CloseIcon,
  FileIcon,
  ShieldIcon,
  TerminalIcon,
  TrashIcon,
} from "../icons";
import type { HostFingerprint } from "../../domain/security";
import { useSavedCredential } from "../../app/useSavedCredential";
import {
  loadAuthPref,
  saveAuthPref,
  type AuthMethodChoice,
} from "../../app/authPreferences";
import { moveRadioGroupFocus } from "../overlays/radioNavigation";

const authMethodChoices = ["password", "privateKey"] as const;

export async function choosePrivateKeyPath(
  title: string,
): Promise<string | null> {
  const selected = await open({
    directory: false,
    multiple: false,
    title,
  });
  return typeof selected === "string" ? selected : null;
}

/**
 * The dialogs describe a stored vault entry, while a live connection only has
 * what the server just presented. The identifiers are filled from the target
 * so the two shapes meet without inventing history that has not happened yet.
 */
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
  | { step: "unknownHost"; outcome: Extract<ConnectOutcome, { outcome: "hostUnknown" }> }
  | { step: "changedHost"; outcome: Extract<ConnectOutcome, { outcome: "hostChanged" }> };

function stageKey(stage: string): MessageKey {
  const known = [
    "connect",
    "authenticate",
    "channel",
    "pty",
    "shell",
    "trust",
    "invoke",
    "credential",
  ];
  return (
    known.includes(stage) ? `connect.stage.${stage}` : "connect.stage.connect"
  ) as MessageKey;
}

export function ConnectFlow({
  profile,
  ssh,
  onConnected,
  onCancel,
}: {
  profile: ConnectionProfile;
  ssh: SshApi;
  onConnected: (sessionId: string) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>({ step: "password" });
  const savedCredential = useSavedCredential(profile.id, "sshPassword");
  const [password, setPassword] = useState("");
  const [useSavedPassword, setUseSavedPassword] = useState(false);
  const [rememberPassword, setRememberPassword] = useState(false);
  const [removingCredential, setRemovingCredential] = useState(false);
  const initialPref = loadAuthPref(profile.id);
  const [method, setMethod] = useState<AuthMethodChoice>(
    initialPref?.method ?? "password",
  );
  const [keyPath, setKeyPath] = useState(initialPref?.keyPath ?? "");
  const [choosingKey, setChoosingKey] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [detectedKeys, setDetectedKeys] = useState<string[]>([]);
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

  // Offer the keys that already exist in ~/.ssh; prefill the best one when
  // nothing was remembered. Detection is a listing, never a silent read.
  useEffect(() => {
    let cancelled = false;
    ssh
      .defaultKeys()
      .then((keys) => {
        if (cancelled) return;
        setDetectedKeys(keys);
        setKeyPath((current) => current || keys[0] || "");
      })
      .catch(() => {
        // Outside the desktop shell there is nothing to detect.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

    const usingPassword = method === "password";
    const outcome = await ssh.connect({
      profileId: profile.id,
      hostname: profile.hostname,
      port: profile.port,
      username: profile.username,
      auth: usingPassword
        ? { kind: "password", password: useSavedPassword ? "" : secret }
        : {
            kind: "privateKey",
            path: keyPath.trim(),
            passphrase: passphrase.length > 0 ? passphrase : undefined,
          },
      useSavedPassword: usingPassword && useSavedPassword,
      rememberPassword: usingPassword && !useSavedPassword && rememberPassword,
      // A sensible starting size; the pane corrects it the moment it mounts.
      cols: 80,
      rows: 24,
    });

    switch (outcome.outcome) {
      case "connected":
        // The secrets have done their job; drop them rather than keep them in
        // state. What is remembered is only the method and the key path.
        setPassword("");
        setPassphrase("");
        saveAuthPref(profile.id, { method, keyPath: keyPath.trim() });
        onConnected(outcome.sessionId);
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
          body: t(
            method === "privateKey"
              ? "connect.keyRejected"
              : "connect.authFailed",
          ),
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

  async function chooseKey() {
    setChoosingKey(true);
    setProblem(null);
    try {
      const selected = await choosePrivateKeyPath(t("connect.keyPath.choose"));
      if (selected) setKeyPath(selected);
    } catch (reason) {
      setProblem({
        title: t("connect.keyPath.chooseFailed.title"),
        body: t("connect.keyPath.chooseFailed", {
          detail: reason instanceof Error ? reason.message : String(reason),
        }),
      });
    } finally {
      setChoosingKey(false);
    }
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
    if (method === "privateKey" && !keyPath.trim()) {
      setProblem({
        title: t("connect.failed.title"),
        body: t("connect.noKeyPath"),
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
        onTrustAndSave={() => {
          void (async () => {
            await ssh.trustHost(host, port, algorithm, fingerprint);
            // Trust is recorded, so the same attempt now gets past the check.
            await attempt(password);
          })();
        }}
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
        onAcceptRiskAndReplace={() => {
          void (async () => {
            await ssh.trustHost(host, port, algorithm, receivedFingerprint);
            await attempt(password);
          })();
        }}
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
        aria-labelledby="connect-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog__head">
          <span className="dialog__icon dialog__icon--inline" aria-hidden="true">
            <TerminalIcon size={18} />
          </span>
          <h2 className="dialog__title" id="connect-title">
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

          <div className="field">
            <span className="field__label">{t("connect.method")}</span>
            <div
              role="radiogroup"
              aria-label={t("connect.method")}
              style={{ display: "flex", gap: "var(--space-2)" }}
            >
              {authMethodChoices.map((choice, index) => (
                <button
                  key={choice}
                  type="button"
                  role="radio"
                  aria-checked={method === choice}
                  tabIndex={method === choice ? 0 : -1}
                  className={`button ${method === choice ? "button--secondary" : "button--ghost"}`}
                  style={{ flex: 1 }}
                  disabled={busy}
                  onClick={() => {
                    setMethod(choice);
                    setProblem(null);
                  }}
                  onKeyDown={(event) =>
                    moveRadioGroupFocus(event, index, (nextIndex) => {
                      setMethod(authMethodChoices[nextIndex]);
                      setProblem(null);
                    })
                  }
                >
                  {t(
                    choice === "password"
                      ? "connect.method.password"
                      : "connect.method.privateKey",
                  )}
                </button>
              ))}
            </div>
          </div>

          {method === "password" && savedCredential.state.mode === "saved" && (
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

          {method === "password" && savedCredential.state.mode === "unavailable" && (
            <Callout tone="warn" title={t("credential.unavailable.title")}>
              {t(
                savedCredential.state.runtimeUnavailable
                  ? "credential.unavailable.browserBody"
                  : "credential.unavailable.body",
                { detail: savedCredential.state.detail },
              )}
            </Callout>
          )}

          {method === "password" && !useSavedPassword && (
            <div className="field">
              <label className="field__label" htmlFor="connect-password">
                {t("connect.password")}
              </label>
              <input
                id="connect-password"
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

          {method === "privateKey" && (
            <>
              <div className="field">
                <label className="field__label" htmlFor="connect-key-path">
                  {t("connect.keyPath")}
                </label>
                <div className="field__input-action">
                  <input
                    id="connect-key-path"
                    className="input mono"
                    type="text"
                    list="connect-key-suggestions"
                    value={keyPath}
                    onChange={(event) => setKeyPath(event.currentTarget.value)}
                    placeholder={t("connect.keyPath.placeholder")}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy || choosingKey}
                  />
                  <button
                    type="button"
                    className="button button--secondary field__input-action-button"
                    onClick={() => void chooseKey()}
                    disabled={busy || choosingKey}
                  >
                    <FileIcon size={14} />
                    {t("connect.keyPath.choose")}
                  </button>
                </div>
                {detectedKeys.length > 0 && (
                  <datalist id="connect-key-suggestions">
                    {detectedKeys.map((key) => (
                      <option value={key} key={key} />
                    ))}
                  </datalist>
                )}
                <p className="field__optional">{t("connect.keyPath.hint")}</p>
              </div>

              <div className="field">
                <label className="field__label" htmlFor="connect-passphrase">
                  {t("connect.passphrase")}
                </label>
                <input
                  id="connect-passphrase"
                  className="input"
                  type="password"
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.currentTarget.value)}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                />
                <p className="field__optional">{t("connect.passphrase.hint")}</p>
              </div>
            </>
          )}

          {method === "password" &&
            !useSavedPassword &&
            savedCredential.state.mode === "missing" && (
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
              {busy ? t("connect.connecting") : t("connect.submit")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
