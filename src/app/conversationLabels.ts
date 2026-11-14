import { agentDisplayName } from "./agentNames";
import { displayPath } from "./displayPath";

export interface ConversationLabels {
  provider: string | null;
  source: string;
  model: string | null;
  endpoint: string | null;
  account: string | null;
  project: string | null;
}

export function conversationLabels({ definitionId, directApi = false, model, endpoint, account, workingDirectory, provider }: {
  provider?: string | null;
  definitionId: string;
  directApi?: boolean;
  model?: string | null;
  endpoint?: string | null;
  account?: string | null;
  workingDirectory?: string;
}): ConversationLabels {
  const name = definitionId === "codex" ? "Codex" : agentDisplayName(definitionId);
  const path = displayPath(workingDirectory ?? "").replace(/[\\/]+$/, "");
  // A CLI/model brand does not identify its upstream. Keep the provider
  // actually reported by the session, including user-defined adapters.
  const reported = provider?.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 128);
  const providerNames = new Map([["openai", "OpenAI"], ["anthropic", "Anthropic"], ["google", "Google"], ["cliproxyapi", "CLIProxyAPI"]]);
  const upstream = !directApi && !endpoint && reported
    ? /^latticeterm_cliproxyapi(?:_[a-z0-9_]+)?$/.test(reported) ? "CLIProxyAPI" : providerNames.get(reported.toLowerCase()) ?? reported
    : null;
  return { provider: upstream, source: directApi ? `${name} API` : definitionId === "codex" ? "Codex CLI" : name,
    model: model?.trim() || null, endpoint: endpoint?.trim() || null, account: account?.trim() || null,
    project: path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1) || null };
}
