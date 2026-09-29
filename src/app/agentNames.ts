/** Built-in CLIs: id, display name, executable, native resume support. */
export const FALLBACK_CATALOG_SOURCE: [string, string, string, boolean][] = [
  ["codex", "OpenAI Codex", "codex", true],
  ["claude", "Claude Code", "claude", true],
  ["gemini", "Gemini CLI", "gemini", true],
  ["antigravity", "Google Antigravity CLI", "agy", true],
  ["opencode", "OpenCode", "opencode", false],
  ["copilot", "GitHub Copilot CLI", "copilot", false],
  ["hermes", "Hermes Agent", "hermes", true],
  ["cursor", "Cursor Agent", "agent", true],
  ["aider", "Aider", "aider", false],
  ["qwen", "Qwen Code", "qwen", false],
  ["kimi", "Kimi Code CLI", "kimi", false],
  ["droid", "Factory Droid", "droid", false],
  ["grok", "Grok CLI", "grok", false],
];

const NAMES = new Map(FALLBACK_CATALOG_SOURCE.map(([id, label]) => [id, label]));

/** Display name for a CLI id, or the id itself for custom CLIs. */
export function agentDisplayName(definitionId: string): string {
  return NAMES.get(definitionId) ?? definitionId;
}
