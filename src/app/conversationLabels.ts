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
  const upstream = !directApi && !endpoint && provider?.trim().toLowerCase() === "openai" ? "OpenAI" : null;
  return { provider: upstream, source: directApi ? `${name} API` : definitionId === "codex" ? "Codex CLI" : name,
    model: model?.trim() || null, endpoint: endpoint?.trim() || null, account: account?.trim() || null,
    project: path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1) || null };
}
