import type { Preferences } from "../../app/preferences";
import { DEFAULT_INTERFACE_SCALE, DEFAULT_OUTPUT_FONT_SIZE } from "../../app/typography";
import { useI18n } from "../../i18n/context";

export function TypographySettings({ preferences, onChange }: {
  preferences: Preferences;
  onChange: (patch: Partial<Preferences>) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="typography-settings">
      <div className="setting">
        <div className="setting__text">
          <label className="setting__title" htmlFor="interface-text-scale">{t("settings.interfaceScale")}</label>
          <p className="setting__description" id="interface-text-scale-hint">{t("settings.interfaceScaleHint")}</p>
        </div>
        <div className="typography-settings__control">
          <input id="interface-text-scale" type="range" min={100} max={200} step={10}
            aria-describedby="interface-text-scale-hint" aria-valuetext={`${preferences.interfaceScale}%`}
            value={preferences.interfaceScale} onChange={event => onChange({ interfaceScale: Number(event.target.value) })} />
          <output htmlFor="interface-text-scale">{preferences.interfaceScale}%</output>
        </div>
      </div>
      <div className="setting">
        <div className="setting__text">
          <label className="setting__title" htmlFor="output-font-size">{t("settings.outputFontSize")}</label>
          <p className="setting__description" id="output-font-size-hint">{t("settings.outputFontSizeHint")}</p>
        </div>
        <div className="typography-settings__control">
          <input id="output-font-size" type="range" min={12} max={32} step={1}
            aria-describedby="output-font-size-hint" aria-valuetext={`${preferences.outputFontSize} px`}
            value={preferences.outputFontSize} onChange={event => onChange({ outputFontSize: Number(event.target.value) })} />
          <output htmlFor="output-font-size">{preferences.outputFontSize} px</output>
        </div>
      </div>
      <pre className="typography-settings__preview" aria-label={t("settings.fontPreview")}>{t("settings.fontPreviewText")}</pre>
      <button type="button" className="button button--secondary" onClick={() => onChange({
        interfaceScale: DEFAULT_INTERFACE_SCALE, outputFontSize: DEFAULT_OUTPUT_FONT_SIZE,
      })}>{t("settings.resetFontSize")}</button>
    </div>
  );
}
