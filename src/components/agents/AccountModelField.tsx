import { accountModelKey, type AccountModelOption, type AccountModelSelection } from "../../app/accountModels";
import { useI18n } from "../../i18n/context";

export function AccountModelField({ options, value, disabled, onChange }: {
  options: readonly AccountModelOption[];
  value: AccountModelSelection | null;
  disabled?: boolean;
  onChange: (selection: AccountModelSelection) => void;
}) {
  const { t } = useI18n();
  const selectedKey = value ? accountModelKey(value) : "";
  const missing = value && !options.some((option) => accountModelKey(option) === selectedKey);
  return <label className="field field--grow">
    <span className="field__label">{t("chat.model")}</span>
    <select className="select" value={selectedKey} disabled={disabled} onChange={(event) => {
      const selected = options.find((option) => accountModelKey(option) === event.currentTarget.value);
      if (selected && !selected.disabled) onChange(selected);
    }}>
      {!value && <option value="" disabled>{t("accountModel.choose")}</option>}
      {missing && <option value={selectedKey} disabled>{t("accountModel.missing")}</option>}
      {options.map((option) => <option key={accountModelKey(option)} value={accountModelKey(option)} disabled={option.disabled}>{option.label}</option>)}
    </select>
  </label>;
}
