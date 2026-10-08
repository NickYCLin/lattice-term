import { useRef, useState, type KeyboardEvent } from "react";
import type { VaultApi } from "../../app/useVault";
import { useI18n } from "../../i18n/context";
import { Callout } from "../common/Callout";

export function CredentialVaultAccess({ vault, disabled, onReady }: {
  vault: VaultApi;
  disabled: boolean;
  onReady: () => Promise<void>;
}) {
  const { t } = useI18n();
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [hasPassword, setHasPassword] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const creating = vault.status?.state === "notCreated";
  const blocked = disabled || vault.busy || pending;

  async function openVault() {
    if (disabled || vault.busy || pendingRef.current) return;
    const password = passwordRef.current?.value ?? "";
    if (!password || (creating && password.length < 8)) return;
    pendingRef.current = true;
    setPending(true);
    setNotice(null);
    try {
      if (creating && password !== confirmRef.current?.value) {
        setNotice(t("vault.encrypted.mismatch"));
        return;
      }
      const opened = await (creating ? vault.create(password) : vault.unlock(password));
      if (opened) await onReady();
    } finally {
      if (passwordRef.current) passwordRef.current.value = "";
      if (confirmRef.current) confirmRef.current.value = "";
      setHasPassword(false);
      pendingRef.current = false;
      setPending(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    void openVault();
  }

  return <Callout tone="warn" title={t(creating ? "vault.encrypted.state.notCreated" : "vault.encrypted.lockedWarnTitle")}>
    <p>{t(creating ? "vault.encrypted.body" : "vault.encrypted.lockedWarnBody")}</p>
    {vault.problem && <p role="alert">{vault.problem}</p>}
    {notice && <p role="alert">{notice}</p>}
    <div className="stack">
      <div className="field">
        <label className="field__label" htmlFor="credential-vault-password">{t("vault.encrypted.masterPassword")}</label>
        <input id="credential-vault-password" className="input" type="password" ref={passwordRef}
          autoComplete={creating ? "new-password" : "current-password"} disabled={blocked}
          onChange={event => setHasPassword(creating ? event.currentTarget.value.length >= 8 : event.currentTarget.value.length > 0)}
          onKeyDown={onKeyDown} />
        {creating && <p className="field__optional">{t("vault.encrypted.masterHint")}</p>}
      </div>
      {creating && <div className="field">
        <label className="field__label" htmlFor="credential-vault-confirm">{t("vault.encrypted.confirmPassword")}</label>
        <input id="credential-vault-confirm" className="input" type="password" ref={confirmRef}
          autoComplete="new-password" disabled={blocked} onKeyDown={onKeyDown} />
      </div>}
      <div>
        <button type="button" className="button button--secondary" disabled={blocked || !hasPassword}
          onClick={() => { void openVault(); }}>
          {pending || vault.busy ? t("vault.encrypted.working") : t(creating ? "vault.encrypted.create" : "vault.encrypted.unlock")}
        </button>
      </div>
    </div>
  </Callout>;
}
