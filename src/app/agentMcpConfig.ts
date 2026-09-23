/**
 * Client configuration for the LatticeTerm MCP server, rendered from the
 * launch line the backend reports (the executable of this very
 * installation and its data directory).  Each MCP client keeps its
 * servers in a different place, so the same command is shown three ways.
 */
import type { AgentMcpLaunch } from "./useAgentDaemon";

export const MCP_SERVER_NAME = "latticeterm";

/** Shell-quotes one word when it needs it; leaves plain words alone. */
export function shellWord(word: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The `claude mcp add` line for Claude Code. */
export function claudeCodeCommand(launch: AgentMcpLaunch): string {
  return ["claude", "mcp", "add", MCP_SERVER_NAME, "--", launch.command, ...launch.args]
    .map(shellWord)
    .join(" ");
}

/** The `codex mcp add` line for Codex CLI; it writes the same
 * `[mcp_servers.latticeterm]` entry into `~/.codex/config.toml`. */
export function codexCommand(launch: AgentMcpLaunch): string {
  return ["codex", "mcp", "add", MCP_SERVER_NAME, "--", launch.command, ...launch.args]
    .map(shellWord)
    .join(" ");
}

/** The `mcpServers` JSON most other clients read (Gemini CLI, Cursor, Claude Desktop). */
export function mcpServersJson(launch: AgentMcpLaunch): string {
  return JSON.stringify(
    { mcpServers: { [MCP_SERVER_NAME]: { command: launch.command, args: launch.args } } },
    null,
    2,
  );
}
