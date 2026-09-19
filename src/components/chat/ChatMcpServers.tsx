import { useEffect, useState } from "react";
import type { ChatDefinitionId } from "../../app/agentChat";
import { copyTextToClipboard } from "../../app/clipboardText";
import { displayPath } from "../../app/displayPath";
import { hasDesktopBackend } from "../../app/nativeRuntime";
import { useI18n } from "../../i18n/context";
import type { MessageKey } from "../../i18n/messages/zh-TW";
import { CopyIcon } from "../icons";

export interface McpServerInfo {
  name: string;
  scope: "user" | "project" | "local";
  source: string;
  transport: string;
  target: string;
  enabled: boolean;
  envKeys: string[];
  headerKeys: string[];
}

const scopeKey: Record<McpServerInfo["scope"], MessageKey> = {
  user: "chat.mcp.scope.user",
  project: "chat.mcp.scope.project",
  local: "chat.mcp.scope.local",
};

/** Each CLI's own commands; the window never edits their config files. */
export function mcpCommands(definitionId: ChatDefinitionId, server: Pick<McpServerInfo, "name" | "scope" | "transport">) {
  const name = /^[\w.-]+$/.test(server.name) ? server.name : JSON.stringify(server.name);
  if (definitionId === "claude") {
    return {
      remove: `claude mcp remove ${name} -s ${server.scope}`,
      login: server.transport === "stdio" ? null : "claude  →  /mcp",
    };
  }
  if (definitionId === "codex") {
    return {
      remove: `codex mcp remove ${name}`,
      login: server.transport === "stdio" ? null : `codex mcp login ${name}`,
    };
  }
  return {
    remove: `gemini mcp remove ${name}${server.scope === "user" ? " --scope user" : ""}`,
    login: server.transport === "stdio" ? null : `gemini  →  /mcp auth ${name}`,
  };
}

export function mcpAddCommand(definitionId: ChatDefinitionId): string {
  if (definitionId === "claude") return "claude mcp add <name> -- <command> [args…]";
  if (definitionId === "codex") return "codex mcp add <name> -- <command> [args…]";
  return "gemini mcp add <name> <command> [args…]";
}

function CopyCommand({ command }: { command: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <span className="chat-mcp__command">
      <code>{command}</code>
      <button
        type="button"
        className="button button--ghost button--sm"
        aria-label={t("chat.mcp.copy")}
        title={copied ? t("chat.mcp.copied") : t("chat.mcp.copy")}
        onClick={() => {
          void copyTextToClipboard(command).then(() => setCopied(true)).catch(() => {});
        }}
      >
        <CopyIcon size={13} />
      </button>
    </span>
  );
}

/**
 * The MCP servers this conversation's assistant will load, as its own
 * configuration says. Values of environment variables and headers never
 * reach the window; changes go through the CLI's own commands.
 */
export function ChatMcpServers({
  definitionId,
  workingDirectory,
  configDirectory,
}: {
  definitionId: ChatDefinitionId;
  workingDirectory: string;
  configDirectory: string | null;
}) {
  const { t } = useI18n();
  const [servers, setServers] = useState<McpServerInfo[] | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!hasDesktopBackend()) return;
    let cancelled = false;
    setError("");
    void import("@tauri-apps/api/core")
      .then(({ invoke }) =>
        invoke<McpServerInfo[]>("agent_mcp_servers", {
          definitionId,
          workingDirectory: workingDirectory || null,
          configDirectory,
        }),
      )
      .then((next) => {
        if (!cancelled) setServers(next);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [definitionId, workingDirectory, configDirectory, revision]);

  return (
    <details className="chat-instructions">
      <summary>
        {t("chat.mcp.title")}
        {servers && <span className="chat-chip">{servers.filter((server) => server.enabled).length}</span>}
      </summary>
      <p className="chat-settings__hint">{t("chat.mcp.hint")}</p>
      {error && <p className="field__error">{error}</p>}
      {servers && servers.length === 0 && <p className="chat-settings__hint">{t("chat.mcp.none")}</p>}
      {definitionId === "claude" && <p className="chat-settings__hint">{t("chat.mcp.claudeConnectors")}</p>}
      <ul className="chat-mcp">
        {servers?.map((server) => {
          const commands = mcpCommands(definitionId, server);
          return (
            <li key={`${server.scope}:${server.source}:${server.name}`} className={server.enabled ? undefined : "is-disabled"}>
              <div className="chat-mcp__head">
                <strong>{server.name}</strong>
                <span className="chat-chip">{t(scopeKey[server.scope])}</span>
                <span className="chat-chip">{server.transport}</span>
                {!server.enabled && <span className="chat-chip">{t("chat.mcp.disabled")}</span>}
              </div>
              <code className="chat-mcp__target" title={server.target}>{server.target}</code>
              {(server.envKeys.length > 0 || server.headerKeys.length > 0) && (
                <p className="chat-settings__hint">
                  {t("chat.mcp.secrets", { names: [...server.envKeys, ...server.headerKeys].join(", ") })}
                </p>
              )}
              <p className="chat-settings__hint" title={server.source}>{displayPath(server.source)}</p>
              <CopyCommand command={commands.remove} />
              {commands.login && <CopyCommand command={commands.login} />}
            </li>
          );
        })}
      </ul>
      <p className="chat-settings__hint">{t("chat.mcp.add")}</p>
      <CopyCommand command={mcpAddCommand(definitionId)} />
      <button type="button" className="button button--ghost button--sm" onClick={() => setRevision((current) => current + 1)}>
        {t("chat.instructions.reload")}
      </button>
    </details>
  );
}
