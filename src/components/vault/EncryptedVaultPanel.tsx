import { DesktopDescription } from "../common/MobilePresentation";
/**
 * The encrypted vault's control panel: create, unlock, lock, change the
 * master password, and choose which store new secrets go to.
 *
 * Passwords typed here go straight into one command call and are dropped;
 * nothing secret stays in component state after an action completes.
 */

import { useState } from "react";
import type { FormEvent } from "react";
import type { VaultApi } from "../../app/useVault";
import { displayPath } from "../../app/displayPath";
import { useI18n } from "../../i18n/context";
import { Callout } from "../common/Callout";
import { Chip } from "../common/Badge";
import { LockIcon, ShieldIcon, UnlockIcon } from "../icons";
import { moveRadioGroupFocus } from "../overlays/radioNavigation";

export function EncryptedVaultPanel({ vault }: { vault: VaultApi }) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const status = vault.status;

  async function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(null);
    if (password !== confirm) {
      setNotice(t("vault.encrypted.mismatch"));
      return;
    }
    if (await vault.create(password)) {
      setPassword("");
      setConfirm("");
      setNotice(t("vault.encrypted.created"));
    }
  }

  async function submitUnlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(null);
    if (await vault.unlock(password)) {
      setPassword("");
    }
  }

  async function submitChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(null);
    if (await vault.changePassword(currentPassword, nextPassword)) {
      setCurrentPassword("");
      setNextPassword("");
      setNotice(t("vault.encrypted.changed"));
    }
  }

  function lockVault() {
    setNotice(null);
    void vault.lock();
  }

  if (!status) {
    return (
      <Callout tone="info" title={t("vault.encrypted.title")}>
        {t("vault.encrypted.desktopOnly")}
      </Callout>
    );
  }

  return (
    <div className="stack" style={{ gap: "var(--space-5)", maxWidth: 560 }}>
      <DesktopDescription><Callout tone="security" title={t("vault.encrypted.title")}>
        {t("vault.encrypted.body")}
      </Callout></DesktopDescription>

      {vault.problem && (
        <Callout tone="warn" title={t("vault.encrypted.failedTitle")}>
          {vault.problem}
        </Callout>
      )}
      {notice && !vault.problem && (
        <Callout tone="info" title={t("vault.encrypted.noticeTitle")}>
          {notice}
        </Callout>
      )}

      {/* Current state, always visible. */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
        {status.state === "unlocked" ? (
          <Chip tone="ok">
            <UnlockIcon size={12} /> {t("vault.encrypted.state.unlocked")}
          </Chip>
        ) : status.state === "locked" ? (
          <Chip tone="warn">
            <LockIcon size={12} /> {t("vault.encrypted.state.locked")}
          </Chip>
        ) : (
          <Chip tone="neutral">{t("vault.encrypted.state.notCreated")}</Chip>
        )}
        {status.state === "unlocked" && status.entryCount !== null && (
          <span className="text-muted" style={{ fontSize: "var(--text-sm)" }}>
            {t("vault.encrypted.entryCount", { count: status.entryCount })}
          </span>
        )}
      </div>

      {status.state === "notCreated" && (
        <form className="stack" style={{ gap: "var(--space-3)" }} onSubmit={submitCreate}>
          <div className="field">
            <label className="field__label" htmlFor="vault-create-password">
              {t("vault.encrypted.masterPassword")}
            </label>
            <input
              id="vault-create-password"
              className="input"
              type="password"
              value={password}
              autoComplete="new-password"
              disabled={vault.busy}
              onChange={(event) => setPassword(event.currentTarget.value)}
            />
            <DesktopDescription><p className="field__optional">{t("vault.encrypted.masterHint")}</p></DesktopDescription>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="vault-create-confirm">
              {t("vault.encrypted.confirmPassword")}
            </label>
            <input
              id="vault-create-confirm"
              className="input"
              type="password"
              value={confirm}
              autoComplete="new-password"
              disabled={vault.busy}
              onChange={(event) => setConfirm(event.currentTarget.value)}
            />
          </div>
          <div>
            <button
              type="submit"
              className="button button--primary"
              disabled={vault.busy || password.length === 0}
            >
              <ShieldIcon size={14} />
              {vault.busy ? t("vault.encrypted.working") : t("vault.encrypted.create")}
            </button>
          </div>
        </form>
      )}

      {status.state === "locked" && (
        <form className="stack" style={{ gap: "var(--space-3)" }} onSubmit={submitUnlock}>
          <div className="field">
            <label className="field__label" htmlFor="vault-unlock-password">
              {t("vault.encrypted.masterPassword")}
            </label>
            <input
              id="vault-unlock-password"
              className="input"
              type="password"
              value={password}
              autoComplete="current-password"
              disabled={vault.busy}
              onChange={(event) => setPassword(event.currentTarget.value)}
            />
          </div>
          <div>
            <button
              type="submit"
              className="button button--primary"
              disabled={vault.busy || password.length === 0}
            >
              <UnlockIcon size={14} />
              {vault.busy ? t("vault.encrypted.working") : t("vault.encrypted.unlock")}
            </button>
          </div>
        </form>
      )}

      {status.state === "unlocked" && (
        <>
          <div>
            <button
              type="button"
              className="button button--secondary"
              disabled={vault.busy}
              onClick={lockVault}
            >
              <LockIcon size={14} />
              {t("vault.encrypted.lock")}
            </button>
          </div>

          <form className="stack" style={{ gap: "var(--space-3)" }} onSubmit={submitChange}>
            <h3 className="eyebrow">{t("vault.encrypted.changeTitle")}</h3>
            <div className="field">
              <label className="field__label" htmlFor="vault-current-password">
                {t("vault.encrypted.currentPassword")}
              </label>
              <input
                id="vault-current-password"
                className="input"
                type="password"
                value={currentPassword}
                autoComplete="current-password"
                disabled={vault.busy}
                onChange={(event) => setCurrentPassword(event.currentTarget.value)}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="vault-next-password">
                {t("vault.encrypted.newPassword")}
              </label>
              <input
                id="vault-next-password"
                className="input"
                type="password"
                value={nextPassword}
                autoComplete="new-password"
                disabled={vault.busy}
                onChange={(event) => setNextPassword(event.currentTarget.value)}
              />
            </div>
            <div>
              <button
                type="submit"
                className="button button--ghost"
                disabled={
                  vault.busy || currentPassword.length === 0 || nextPassword.length === 0
                }
              >
                {t("vault.encrypted.change")}
              </button>
            </div>
          </form>
        </>
      )}

      {/* Which store receives new secrets. */}
      <div className="stack" style={{ gap: "var(--space-2)" }}>
        <h3 className="eyebrow">{t("vault.encrypted.backendTitle")}</h3>
        <p className="text-muted" style={{ fontSize: "var(--text-sm)", margin: 0 }}>
          {t("vault.encrypted.backendBody")}
        </p>
        <div role="radiogroup" aria-label={t("vault.encrypted.backendTitle")} style={{ display: "flex", gap: "var(--space-2)" }}>
          <button
            type="button"
            role="radio"
            aria-checked={vault.backend === "osKeyring"}
            tabIndex={vault.backend === "osKeyring" ? 0 : -1}
            className={`button ${vault.backend === "osKeyring" ? "button--secondary" : "button--ghost"}`}
            disabled={vault.busy}
            onClick={() => void vault.setBackend("osKeyring")}
            onKeyDown={(event) =>
              moveRadioGroupFocus(event, 0, (nextIndex) =>
                void vault.setBackend(nextIndex === 0 ? "osKeyring" : "vault"),
              )
            }
          >
            {t("vault.encrypted.backend.osKeyring")}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={vault.backend === "vault"}
            tabIndex={vault.backend === "vault" ? 0 : -1}
            className={`button ${vault.backend === "vault" ? "button--secondary" : "button--ghost"}`}
            disabled={vault.busy || status.state === "notCreated"}
            onClick={() => void vault.setBackend("vault")}
            onKeyDown={(event) =>
              moveRadioGroupFocus(event, 1, (nextIndex) =>
                void vault.setBackend(nextIndex === 0 ? "osKeyring" : "vault"),
              )
            }
          >
            {t("vault.encrypted.backend.vault")}
          </button>
        </div>
        {vault.backend === "vault" && status.state !== "unlocked" && (
          <Callout tone="warn" title={t("vault.encrypted.lockedWarnTitle")}>
            {t("vault.encrypted.lockedWarnBody")}
          </Callout>
        )}
      </div>

      <p className="text-faint mono" style={{ fontSize: "var(--text-2xs)", margin: 0 }}>
        {displayPath(status.path)}
      </p>
    </div>
  );
}
