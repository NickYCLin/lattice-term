import type { ChatDefinitionId, ChatModelList } from "./agentChat";
import { profilesFor, type ChatAccountProfile } from "./chatAccountProfiles";
import type { AccountProfileStatuses } from "./useAccountProfileStatus";
import {
  CLI_PROXY_DEFAULT_ID,
  CLI_PROXY_NAME,
  cliProxyIdFromArguments,
  cliProxyLabel,
  cliProxyLaunchArguments,
  type CliProxyEndpoint,
} from "./cliProxyApi";
import type { AgentDefinition, AgentLaunchRequest, AgentSessionSummary } from "./useAgentSessions";

export interface AccountModelSelection {
  definitionId: string;
  accountProfileId: string | null;
  model: string;
  provider?: "cliproxyapi";
  /** Which configured proxy answers, when the provider is the proxy. */
  proxyId?: string;
}

export interface AccountModelTarget {
  definitionId: string;
  accountProfileId: string | null;
  configDirectory: string | null;
  accountName: string;
  cliLabel: string;
  signedOut: boolean;
  showAccount: boolean;
}

export interface AccountModelOption extends AccountModelSelection {
  label: string;
  disabled: boolean;
}

export function hasChatModels(id: string): id is ChatDefinitionId {
  return id === "codex" || id === "claude" || id === "gemini" || id === "antigravity";
}

export function accountModelKey(selection: AccountModelSelection): string {
  // CLIProxyAPI's model ID is entered separately from the account/provider picker.
  return JSON.stringify([
    selection.definitionId,
    selection.accountProfileId,
    selection.provider ?? null,
    selection.provider ? selection.proxyId ?? CLI_PROXY_DEFAULT_ID : null,
    selection.provider ? "" : selection.model,
  ]);
}

export function accountModelTargetKey(target: Pick<AccountModelTarget, "definitionId" | "configDirectory">): string {
  return JSON.stringify([target.definitionId, target.configDirectory]);
}

export function accountModelTargets(
  definitions: readonly AgentDefinition[],
  profiles: readonly ChatAccountProfile[],
  statuses: AccountProfileStatuses,
  defaultAccount: string,
): AccountModelTarget[] {
  return definitions.flatMap((definition) => {
    const named = profilesFor(profiles, definition.id);
    const targets = [
      {
        definitionId: definition.id,
        accountProfileId: null,
        configDirectory: null,
        accountName: definition.account.label || defaultAccount,
        cliLabel: definition.label,
        signedOut: definition.account.state === "signedOut",
        showAccount: false,
      },
      ...named.map((profile) => ({
        definitionId: definition.id,
        accountProfileId: profile.id,
        configDirectory: profile.configDirectory,
        accountName: profile.name,
        cliLabel: definition.label,
        signedOut: statuses[profile.id]?.state === "signedOut",
        showAccount: false,
      })),
    ];
    // Unknown login state is still selectable; native/keychain-backed logins
    // cannot always be detected from a file. Never hide a usable account.
    const multiple = targets.filter((target) => !target.signedOut).length > 1;
    return targets.map((target) => ({ ...target, showAccount: multiple }));
  });
}

export function accountModelOptions(
  targets: readonly AccountModelTarget[],
  lists: Readonly<Record<string, ChatModelList>>,
  labels: { defaultModel: string; loading: string; signedOut: string },
  selected?: AccountModelSelection,
  proxies: readonly CliProxyEndpoint[] = [],
): AccountModelOption[] {
  return targets.flatMap((target) => {
    const list = lists[accountModelTargetKey(target)];
    const choices = list?.state === "ready" ? [...list.models] : [];
    if (!choices.some((choice) => choice.value === "")) {
      choices.unshift({ value: "", label: list?.state === "loading" ? labels.loading : labels.defaultModel, description: null, isDefault: true });
    }
    if (!selected?.provider && selected?.definitionId === target.definitionId && selected.accountProfileId === target.accountProfileId && selected.model && !choices.some((choice) => choice.value === selected.model)) {
      choices.push({ value: selected.model, label: selected.model, description: null, isDefault: false });
    }
    const options: AccountModelOption[] = choices.map((choice) => ({
      definitionId: target.definitionId,
      accountProfileId: target.accountProfileId,
      model: choice.value,
      label: [target.showAccount || target.signedOut ? target.accountName : null, target.cliLabel, choice.label].filter(Boolean).join(" · ") + (target.signedOut ? `（${labels.signedOut}）` : ""),
      disabled: target.signedOut,
    }));
    // One entry per configured proxy; the picker already groups them under
    // the proxy's own heading, so the option names the proxy, not the CLI.
    if (target.definitionId === "codex" && (
      target.accountProfileId === null ||
      (selected?.provider === "cliproxyapi" &&
        selected.accountProfileId === target.accountProfileId)
    )) {
      for (const endpoint of proxies) {
        // Keep an existing named-profile conversation selectable without
        // multiplying every endpoint by every native login in new launchers.
        if (target.accountProfileId !== null &&
          endpoint.id !== (selected?.proxyId ?? CLI_PROXY_DEFAULT_ID)) continue;
        options.push({
          definitionId: "codex",
          accountProfileId: target.accountProfileId,
          model: "",
          provider: "cliproxyapi",
          proxyId: endpoint.id,
          label: [cliProxyLabel(endpoint), target.accountProfileId !== null ? target.accountName : null].filter(Boolean).join(" · "),
          disabled: false,
        });
      }
    }
    return options;
  });
}

/** Resolve the selected identity at launch time. A missing account must not
 * silently fall back to the default login or reuse another account's session. */
export function accountModelLaunchSettings(
  selection: AccountModelSelection,
  profiles: readonly ChatAccountProfile[],
  proxies: readonly CliProxyEndpoint[] = [],
): Pick<AgentLaunchRequest, "profileConfigPath" | "arguments"> {
  const profile = selection.accountProfileId === null ? null : profilesFor(profiles, selection.definitionId).find((entry) => entry.id === selection.accountProfileId);
  if (selection.accountProfileId !== null && !profile) throw new Error("account-model:missing-account");
  const profileConfigPath = profile?.configDirectory ?? null;
  if (!selection.provider) {
    return { profileConfigPath, arguments: selection.model ? ["--model", selection.model] : [] };
  }
  if (selection.provider !== "cliproxyapi" || selection.definitionId !== "codex") throw new Error("account-model:unsupported-provider");
  if (!validCliProxyModel(selection.model)) throw new Error("account-model:invalid-proxy-model");
  // A removed proxy must stop the launch: falling back to another one would
  // send the conversation to a server the user did not choose.
  const wanted = selection.proxyId ?? CLI_PROXY_DEFAULT_ID;
  const endpoint = proxies.find((candidate) => candidate.id === wanted);
  if (!endpoint) throw new Error("account-model:missing-proxy");
  return {
    profileConfigPath,
    arguments: [...cliProxyLaunchArguments(endpoint.baseUrl, endpoint.id), "--model", selection.model],
  };
}

export function validCliProxyModel(model: string): boolean {
  return model.length > 0 && model.length <= 256 && model.trim() === model && !/[\s\p{Cc}]/u.test(model) && !model.startsWith("-");
}

function accountPathKey(path: string | null | undefined): string {
  const normalized = (path ?? "").replace(/^\\\\\?\\/, "").replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized;
}

export function accountSessionLabel(
  session: Pick<AgentSessionSummary, "definitionId" | "label" | "profileConfigPath"> &
    Partial<Pick<AgentSessionSummary, "launchArguments">>,
  targets: readonly AccountModelTarget[],
  missing: string,
  proxies: readonly CliProxyEndpoint[] = [],
): string {
  const proxyId = cliProxyIdFromArguments(session.launchArguments);
  if (proxyId !== null) {
    const endpoint = proxies.find((candidate) => candidate.id === proxyId);
    // The proxy's own name only earns a place once it distinguishes something.
    return endpoint && (endpoint.label !== "" || proxies.length > 1)
      ? `${CLI_PROXY_NAME} · ${cliProxyLabel(endpoint)}`
      : CLI_PROXY_NAME;
  }
  const target = targets.find((entry) => entry.definitionId === session.definitionId && accountPathKey(entry.configDirectory) === accountPathKey(session.profileConfigPath));
  if (!target) return session.profileConfigPath ? `${session.label} · ${missing}` : session.label;
  // Earlier account-login launches included the name in the stored label.
  const label = session.label === `${target.cliLabel} · ${target.accountName}` ? target.cliLabel : session.label;
  return target.showAccount ? `${target.accountName} · ${label}` : label;
}
