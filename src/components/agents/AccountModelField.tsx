import { cliProxyMessageKey, cliProxyModelLabel, cliProxyStatusCode } from "../../app/cliProxyApi";
import type { CliProxyModelList } from "../../app/useCliProxyApi";
import { accountModelKey, type AccountModelOption, type AccountModelSelection } from "../../app/accountModels";
import { useI18n } from "../../i18n/context";

const MANUAL = "\u0000manual";

/**
 * The proxy decides which models it will accept, so the list comes from the
 * proxy rather than from this application. Typing an ID stays available: the
 * proxy may be down, or offering something newer than the list we last read,
 * and neither should stop a launch.
 */
function CliProxyModel({ value, models, disabled, onChange }: {
  value: AccountModelSelection;
  models: CliProxyModelList;
  disabled?: boolean;
  onChange: (selection: AccountModelSelection) => void;
}) {
  const { t } = useI18n();
  const listed = models.state === "ready" ? models.models : [];
  const known = listed.some((model) => model.id === value.model);
  const manual = !known;
  const explain = (reason: unknown) => {
    const key = cliProxyMessageKey(reason);
    if (key) return t(key);
    const status = cliProxyStatusCode(reason);
    return status === null ? t("terminal.proxy.unavailable") : t("cliproxy.models.status", { status });
  };
  return <>
    {listed.length > 0 && <label className="field"><span className="field__label">{t("terminal.proxy.model")}</span>
      <select className="select" value={manual ? MANUAL : value.model} disabled={disabled}
        onChange={(event) => onChange({ ...value, model: event.currentTarget.value === MANUAL ? "" : event.currentTarget.value })}>
        {!value.model && <option value="" disabled>{t("terminal.proxy.choose")}</option>}
        {listed.map((model) => <option key={model.id} value={model.id}>{cliProxyModelLabel(model)}</option>)}
        <option value={MANUAL}>{t("terminal.proxy.manual")}</option>
      </select></label>}
    {models.state === "loading" && <span className="field__hint">{t("settings.cliProxy.modelsLoading")}</span>}
    {models.state === "unavailable" && <span className="field__hint">{explain(models.reason)}</span>}
    {manual && <label className="field"><span className="field__label">{t("terminal.proxy.model")}</span>
      <input className="input" value={value.model} disabled={disabled} maxLength={256} autoComplete="off"
        spellCheck={false} placeholder="gpt-5.6-sol"
        onChange={(event) => onChange({ ...value, model: event.currentTarget.value })} /></label>}
    <span className="field__hint">{t("terminal.proxy.hint")}</span>
  </>;
}

export function AccountModelField({ options, value, disabled, onChange, allowCliProxyApi = false, proxyModels = { state: "idle" } }: {
  options: readonly AccountModelOption[];
  value: AccountModelSelection | null;
  disabled?: boolean;
  allowCliProxyApi?: boolean;
  proxyModels?: CliProxyModelList;
  onChange: (selection: AccountModelSelection) => void;
}) {
  const { t } = useI18n();
  const selectedKey = value ? accountModelKey(value) : "";
  const missing = value && !options.some((option) => accountModelKey(option) === selectedKey);
  return <div className="field field--grow">
    <span className="field__label">{t("chat.model")}</span>
    <select className="select" aria-label={t("chat.model")} value={selectedKey} disabled={disabled} onChange={(event) => {
      const selected = options.find((option) => accountModelKey(option) === event.currentTarget.value);
      if (selected && !selected.disabled) {
        onChange(selected.provider && proxyModels.state === "ready"
          ? { ...selected, model: proxyModels.models[0]?.id ?? "" } : selected);
      }
    }}>
      {!value && <option value="" disabled>{t("accountModel.choose")}</option>}
      {missing && <option value={selectedKey} disabled>{t("accountModel.missing")}</option>}
      {options.map((option) => <option key={accountModelKey(option)} value={accountModelKey(option)} disabled={option.disabled}>{option.label}</option>)}
    </select>
    {allowCliProxyApi && value?.provider === "cliproxyapi" &&
      <CliProxyModel value={value} models={proxyModels} disabled={disabled} onChange={onChange} />}
  </div>;
}
