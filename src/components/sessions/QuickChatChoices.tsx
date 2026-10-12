import type { AccountModelOption, AccountModelSelection } from "../../app/accountModels";
import { accountModelSourceKey } from "../../app/accountModels";
import type { AgentDefinition } from "../../app/useAgentSessions";
import { useI18n } from "../../i18n/context";
import { AgentIcon } from "../icons";

export function QuickChatChoices({ installedAgents, modelOptions = [], onLaunch, onLaunchProxy, menu = false }: {
  installedAgents: readonly AgentDefinition[];
  modelOptions?: readonly AccountModelOption[];
  onLaunch: (definition: AgentDefinition) => void;
  onLaunchProxy?: (selection: AccountModelSelection) => void;
  menu?: boolean;
}) {
  const { t } = useI18n();
  const proxies = onLaunchProxy ? modelOptions.filter(option =>
    option.provider === "cliproxyapi" && option.accountProfileId === null && !option.disabled) : [];
  return <>
    {proxies.map(option => (
      <button type="button" role={menu ? "menuitem" : undefined}
        className="button button--ghost button--sm" key={accountModelSourceKey(option)}
        onClick={() => onLaunchProxy?.({ definitionId: option.definitionId, accountProfileId: null,
          provider: "cliproxyapi", proxyId: option.proxyId, model: "" })}>
        <AgentIcon size={12} />
        <span className="truncate" title={option.label}>{t("settings.cliProxy.title")} · {option.label}</span>
      </button>
    ))}
    {installedAgents.map(definition => (
      <button type="button" role={menu ? "menuitem" : undefined}
        className="button button--ghost button--sm" key={definition.id}
        onClick={() => onLaunch(definition)}>
        <AgentIcon size={12} />
        {definition.label}
      </button>
    ))}
    {menu && installedAgents.length === 0 && proxies.length === 0 && <small>{t("terminal.addCli.none")}</small>}
  </>;
}
