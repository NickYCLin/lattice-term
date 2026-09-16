import { accountModelKey, type AccountModelOption, type AccountModelSelection } from "../../app/accountModels";
import { useI18n } from "../../i18n/context";

export function AccountModelField({ options, value, disabled, onChange, allowCliProxyApi = false }: {
  options: readonly AccountModelOption[];
  value: AccountModelSelection | null;
  disabled?: boolean;
  allowCliProxyApi?: boolean;
  onChange: (selection: AccountModelSelection) => void;
}) {
  const { t } = useI18n();
  const selectedKey = value ? accountModelKey(value) : "";
  const missing = value && !options.some((option) => accountModelKey(option) === selectedKey);
  return <div className="field field--grow">
    <span className="field__label">{t("chat.model")}</span>
    <select className="select" aria-label={t("chat.model")} value={selectedKey} disabled={disabled} onChange={(event) => {
      const selected = options.find((option) => accountModelKey(option) === event.currentTarget.value);
      if (selected && !selected.disabled) onChange(selected);
    }}>
      {!value && <option value="" disabled>{t("accountModel.choose")}</option>}
      {missing && <option value={selectedKey} disabled>{t("accountModel.missing")}</option>}
      {options.map((option) => <option key={accountModelKey(option)} value={accountModelKey(option)} disabled={option.disabled}>{option.label}</option>)}
    </select>
    {allowCliProxyApi && value?.provider === "cliproxyapi" && <>
      <label className="field"><span className="field__label">{t("terminal.proxy.model")}</span>
        <input className="input" value={value.model} disabled={disabled} maxLength={256} autoComplete="off" spellCheck={false} placeholder="gpt-5.6-sol" onChange={(event) => onChange({ ...value, model: event.currentTarget.value })} />
      </label>
      <span className="field__hint">{t("terminal.proxy.hint")}</span>
    </>}
  </div>;
}
