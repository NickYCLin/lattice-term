import { useRef, useState } from "react";
import type { ConnectionProfile } from "../../domain/connection";
import type { JumpRequest } from "../../app/jumpRoutes";
import { useSavedCredential } from "../../app/useSavedCredential";
import { loadAuthPref, saveAuthPref } from "../../app/authPreferences";
import { choosePrivateKeyPath } from "../terminal/ConnectFlow";
import { useModalFocus } from "../overlays/modalFocus";
import { useI18n } from "../../i18n/context";

export function JumpAuthenticationDialog({ gateway, onContinue, onCancel }: {
  gateway: ConnectionProfile; onContinue: (request: JumpRequest) => void; onCancel: () => void;
}) {
  const { t } = useI18n();
  const saved = useSavedCredential(gateway.id, "sshPassword");
  const pref = loadAuthPref(gateway.id);
  const [method, setMethod] = useState(pref?.method ?? "password");
  const [path, setPath] = useState(pref?.keyPath ?? "");
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [useSaved, setUseSaved] = useState(true);
  const [remember, setRemember] = useState(false);
  const [problem, setProblem] = useState("");
  const dialogRef = useRef<HTMLFormElement>(null);
  useModalFocus({ dialogRef, onEscape: onCancel });
  const savedPassword = useSaved && saved.state.mode === "saved";
  return <div className="scrim scrim--center" role="presentation" onMouseDown={onCancel}>
    <form ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-labelledby="jump-auth-title"
      onMouseDown={event => event.stopPropagation()} onSubmit={event => {
        event.preventDefault();
        saveAuthPref(gateway.id, { method, keyPath: path });
        onContinue({ profileId: gateway.id, auth: method === "privateKey" ? { kind: "privateKey", path, passphrase: passphrase || undefined } : { kind: "password", password: savedPassword ? "" : password }, useSavedPassword: method === "password" && savedPassword, rememberPassword: method === "password" && !savedPassword && remember });
      }}>
      <h2 id="jump-auth-title">{t("jump.authenticate", { name: gateway.name })}</h2>
      <p>{t("jump.authHint")}</p>
      <label className="field"><span>{t("jump.authMethod")}</span><select className="select" value={method} onChange={event => setMethod(event.target.value as typeof method)}>
        <option value="password">{t("jump.password")}</option><option value="privateKey">{t("jump.privateKey")}</option>
      </select></label>
      {method === "password" ? <>
        {saved.state.mode === "saved" && <label><input type="checkbox" checked={useSaved} onChange={event => setUseSaved(event.target.checked)} />{t("jump.useSaved")}</label>}
        {!savedPassword && <><label className="field"><span>{t("jump.password")}</span><input className="input" type="password" value={password} required autoComplete="off" onChange={event => setPassword(event.target.value)} /></label>
          <label><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} />{t("jump.remember")}</label></>}
      </> : <><label className="field"><span>{t("jump.privateKey")}</span><input className="input" value={path} required onChange={event => setPath(event.target.value)} /></label>
        <button className="button button--secondary" type="button" onClick={async () => { try { const value = await choosePrivateKeyPath(t("jump.privateKey")); if (value) setPath(value); } catch { setProblem(t("jump.keyFailed")); } }}>{t("jump.chooseKey")}</button>
        <label className="field"><span>{t("jump.passphrase")}</span><input className="input" type="password" value={passphrase} autoComplete="off" onChange={event => setPassphrase(event.target.value)} /></label></>}
      {problem && <p role="alert">{problem}</p>}
      <div className="dialog__actions"><button type="button" className="button button--secondary" onClick={onCancel}>{t("common.cancel")}</button><button type="submit" className="button button--primary" disabled={saved.state.mode === "loading"}>{t("jump.continue")}</button></div>
    </form>
  </div>;
}
