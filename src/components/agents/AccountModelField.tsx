import { CLI_PROXY_DEFAULT_ID, cliProxyMessageKey, cliProxyStatusCode, groupCliProxyModels } from "../../app/cliProxyApi";
import type { CliProxyModelList, CliProxyModelLists } from "../../app/useCliProxyApi";
import { accountModelKey, accountModelSourceKey, type AccountModelOption, type AccountModelSelection } from "../../app/accountModels";
import { useI18n } from "../../i18n/context";

const MANUAL = "\u0000manual";

/**
 * The proxy decides which models it will accept, so the list comes from the
 * proxy rather than from this application. Typing an ID stays available: the
 * proxy may be down, or offering something newer than the list we last read,
 * and neither should stop a launch.
 */
function CliProxyModel({ value, models, disabled, onChange, onReload }: {
  value: AccountModelSelection;
  models: CliProxyModelList;
  disabled?: boolean;
  onChange: (selection: AccountModelSelection) => void;
  onReload?: () => void;
}) {
  const { t } = useI18n();
  const listed = models.state === "ready" ? models.models : [];
  const grouped = groupCliProxyModels(listed);
  const known = listed.some((model) => model.id === value.model);
  const manual = !known;
  const explain = (reason: unknown) => {
    const key = cliProxyMessageKey(reason);
    if (key) return t(key);
    const status = cliProxyStatusCode(reason);
    return status === null ? t("terminal.proxy.unavailable") : t("cliproxy.models.status", { status });
  };
  const renderModel = (model: { id: string }) => <option key={model.id} value={model.id}>{model.id}</option>;
  return <>
    {listed.length > 0 && <label className="field"><span className="field__label">{t("chat.model")}</span>
      <select className="select" value={manual ? MANUAL : value.model} disabled={disabled}
        onChange={(event) => onChange({ ...value, model: event.currentTarget.value === MANUAL ? "" : event.currentTarget.value })}>
        {!value.model && <option value="" disabled>{t("terminal.proxy.choose")}</option>}
        {grouped.map((group) => group.brand
          ? <optgroup key={group.brand} label={group.brand}>{group.models.map(renderModel)}</optgroup>
          : group.models.map(renderModel))}
        <option value={MANUAL}>{t("terminal.proxy.manual")}</option>
      </select></label>}
    {models.state === "loading" && <span className="field__hint">{t("settings.cliProxy.modelsLoading")}</span>}
    {models.state === "unavailable" && <span className="field__hint" role="alert">{explain(models.reason)}</span>}
    {models.state === "unavailable" && onReload && <div>
      <button type="button" className="button button--ghost button--sm" disabled={disabled} onClick={onReload}>
        {t("settings.cliProxy.modelsReload")}</button></div>}
    {manual && <label className="field"><span className="field__label">{t("terminal.proxy.model")}</span>
      <input className="input" value={value.model} disabled={disabled} maxLength={256} autoComplete="off"
        spellCheck={false} placeholder="gpt-5.6-sol"
        onChange={(event) => onChange({ ...value, model: event.currentTarget.value })} /></label>}
    <span className="field__hint">{t("terminal.proxy.hint")}</span>
  </>;
}

interface AccountModelSource {
  key: string;
  label: string;
  proxy: boolean;
  /** Shown under the CLIProxyAPI heading: the proxy itself, or an account
   * whose CLI was pointed at it by hand. */
  underProxy: boolean;
  disabled: boolean;
  options: AccountModelOption[];
}

function accountModelSources(options: readonly AccountModelOption[]): AccountModelSource[] {
  const sources = new Map<string, AccountModelSource>();
  for (const option of options) {
    const key = accountModelSourceKey(option);
    const source = sources.get(key) ?? {
      key,
      label: option.sourceLabel ?? option.label,
      proxy: option.provider === "cliproxyapi",
      underProxy: option.provider === "cliproxyapi" || option.viaCliProxy === true,
      disabled: true,
      options: [],
    };
    source.options.push(option);
    source.disabled &&= option.disabled;
    sources.set(key, source);
  }
  return [...sources.values()];
}

/**
 * Two steps instead of one long list: pick where the conversation runs (an
 * account's CLI or a CLIProxyAPI endpoint), then a model that source offers.
 * Every row of the old list repeated the account and CLI before the model.
 */
export function AccountModelField({ options, value, disabled, onChange, allowCliProxyApi = false, proxyModels = {}, onReloadProxyModels }: {
  options: readonly AccountModelOption[];
  value: AccountModelSelection | null;
  disabled?: boolean;
  allowCliProxyApi?: boolean;
  /** One model list per configured proxy, keyed by its identifier. */
  proxyModels?: CliProxyModelLists;
  /** Ask the proxies again after a failed read, so a launcher does not have to
   * be closed and the settings page opened just to recover a model list. */
  onReloadProxyModels?: () => void;
  onChange: (selection: AccountModelSelection) => void;
}) {
  const { t } = useI18n();
  const listFor = (proxyId: string | undefined): CliProxyModelList =>
    proxyModels[proxyId ?? CLI_PROXY_DEFAULT_ID] ?? { state: "idle" };
  const sources = accountModelSources(options);
  const proxySources = sources.filter((source) => source.underProxy);
  const nativeSources = sources.filter((source) => !source.underProxy);
  const sourceKey = value ? accountModelSourceKey(value) : "";
  const source = sources.find((entry) => entry.key === sourceKey);
  const selectedKey = value ? accountModelKey(value) : "";
  const modelMissing = Boolean(source && !source.proxy && !source.options.some((option) => accountModelKey(option) === selectedKey));

  const chooseSource = (key: string) => {
    const next = sources.find((entry) => entry.key === key);
    if (!next || next.disabled) return;
    const enabled = next.options.filter((option) => !option.disabled);
    // Moving between accounts keeps the model when the new account offers it.
    const selected = enabled.find((option) => !option.provider && value && !value.provider && option.model === value.model) ?? enabled[0];
    if (!selected) return;
    const list = selected.provider ? listFor(selected.proxyId) : null;
    onChange(list?.state === "ready"
      ? { ...selected, model: groupCliProxyModels(list.models)[0]?.models[0]?.id ?? "" } : selected);
  };
  const renderSource = (entry: AccountModelSource) =>
    <option key={entry.key} value={entry.key} disabled={entry.disabled}>{entry.label}</option>;

  return <div className="account-model-field field--grow">
    <label className="field">
      <span className="field__label">{t("accountModel.source")}</span>
      <select className="select" value={source ? sourceKey : ""} disabled={disabled}
        onChange={(event) => chooseSource(event.currentTarget.value)}>
        {!value && <option value="" disabled>{t("accountModel.choose")}</option>}
        {value && !source && <option value="" disabled>{t("accountModel.missing")}</option>}
        {proxySources.length > 0 && <optgroup label={t("settings.cliProxy.title")}>
          {proxySources.map(renderSource)}
        </optgroup>}
        {nativeSources.map(renderSource)}
      </select>
    </label>
    {source && !source.proxy && <label className="field">
      <span className="field__label">{t("chat.model")}</span>
      <select className="select" aria-label={t("chat.model")} value={modelMissing ? "" : selectedKey} disabled={disabled}
        onChange={(event) => {
          const selected = source.options.find((option) => accountModelKey(option) === event.currentTarget.value);
          if (selected && !selected.disabled) onChange(selected);
        }}>
        {modelMissing && <option value="" disabled>{t("accountModel.missing")}</option>}
        {source.options.map((option) => <option key={accountModelKey(option)} value={accountModelKey(option)}
          disabled={option.disabled}>{option.modelLabel ?? option.label}</option>)}
      </select>
    </label>}
    {allowCliProxyApi && value?.provider === "cliproxyapi" &&
      <CliProxyModel value={value} models={listFor(value.proxyId)} disabled={disabled} onChange={onChange}
        onReload={onReloadProxyModels} />}
  </div>;
}
