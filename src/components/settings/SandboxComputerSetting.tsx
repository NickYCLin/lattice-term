import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../i18n/context";

export function SandboxComputerSetting() {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void invoke<boolean>("chat_sandbox_preference").then(value => {
      if (active) setEnabled(value);
    }, reason => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, []);
  async function change(next: boolean) {
    setBusy(true);
    try {
      setEnabled(await invoke<boolean>("chat_sandbox_preference", { enabled: next }));
      setError("");
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  return <label className="field">
    <span><input type="checkbox" checked={enabled === true} disabled={enabled === null || busy}
      onChange={e => void change(e.target.checked)} />{t("settings.sandbox.control")}</span>
    <span className="field__optional">{t("settings.sandbox.hint")}</span>
    {error && <span role="alert">{error}</span>}
  </label>;
}
