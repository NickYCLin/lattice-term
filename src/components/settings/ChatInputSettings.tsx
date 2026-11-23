import { MemoryCompactionSettings } from "./MemoryCompactionSettings";
import { SandboxComputerSetting } from "./SandboxComputerSetting";
import type { Preferences } from "../../app/preferences";
import { useI18n } from "../../i18n/context";

export function ChatInputSettings({ preferences, onChange, windowsDesktop }: {
  windowsDesktop?: boolean;
  preferences: Preferences; onChange: (patch: Partial<Preferences>) => void;
}) {
  const { t } = useI18n();
  return <><section className="panel glass glass--sheen">
    <header className="panel__head"><h2 className="panel__title">{t("settings.chatInput.title")}</h2></header>
    <div className="setting-list setting-list--form">
      {windowsDesktop && <SandboxComputerSetting />}
      <label className="field"><span className="field__label">{t("handoff.setting")}</span>
        <select className="select" value={preferences.codexHandoffMinutes} onChange={event => onChange({ codexHandoffMinutes: Number(event.target.value) })}>
          <option value={0}>{t("handoff.off")}</option>{[2,5,10].map(minutes => <option key={minutes} value={minutes}>{t("handoff.minutes", { minutes })}</option>)}
        </select><span className="field__optional">{t("handoff.settingHint")}</span>
      </label>
      <label className="field"><span className="field__label">{t("settings.chatInput.shortcut")}</span>
        <select className="select" value={preferences.chatSubmitShortcut} onChange={event => onChange({ chatSubmitShortcut: event.target.value as Preferences["chatSubmitShortcut"] })}>
          <option value="enter">{t("settings.chatInput.enter")}</option>
          <option value="modifier-enter">{t("settings.chatInput.modifierEnter")}</option>
        </select>
      </label>
      <label className="field"><span className="field__label">{t("settings.chatInput.working")}</span>
        <select className="select" value={preferences.chatWorkingSubmit} onChange={event => onChange({ chatWorkingSubmit: event.target.value as Preferences["chatWorkingSubmit"] })}>
          <option value="queue">{t("settings.chatInput.queue")}</option>
          <option value="steer">{t("settings.chatInput.steer")}</option>
        </select>
        <span className="field__optional">{t("settings.chatInput.hint")}</span>
      </label>
      <label className="field"><span className="checkbox-row"><input type="checkbox" checked={preferences.chatCollapseCompletedTurns}
        onChange={event => onChange({ chatCollapseCompletedTurns: event.target.checked })} />{t("chat.process.setting")}</span>
        <span className="field__optional">{t("chat.process.settingHint")}</span>
      </label>
    </div>
  </section><MemoryCompactionSettings /></>;
}
