import type { AgentLaunchRequest, AgentSessionSummary } from "./useAgentSessions";

/** Keep configuration, never replay a positional startup prompt in another tree. */
export function sessionWorktreeRequest(session: AgentSessionSummary, directory: string, seedInput: string | null): AgentLaunchRequest {
  if (!["codex", "claude"].includes(session.definitionId)) throw new Error("這個助理尚未支援工作目錄交接。");
  const codex = session.definitionId === "codex";
  const valueFlags = new Set(codex
    ? ["-c", "--config", "-m", "--model", "-a", "--ask-for-approval", "-s", "--sandbox", "-p", "--profile", "--enable", "--disable", "--local-provider"]
    : ["--model", "--effort", "--permission-mode", "--mcp-config", "--settings", "--allowedTools", "--disallowedTools", "--allowed-tools", "--disallowed-tools", "--system-prompt", "--append-system-prompt", "--plugin-dir"]);
  const switches = new Set(codex ? ["--no-alt-screen", "--full-auto", "--dangerously-bypass-approvals-and-sandbox", "--oss", "--search"]
    : ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--strict-mcp-config", "--bare", "--safe-mode"]);
  const arguments_: string[] = [];
  for (let index = 0; index < session.launchArguments.length; index++) {
    const arg = session.launchArguments[index];
    if (arg === "resume" && codex) { if (session.launchArguments[index + 1] === session.capturedSessionId) index++; continue; }
    if (["--last", "--all", "--fork", "--fork-session", "--continue"].includes(arg) || !codex && arg === "-c") continue;
    if (["--resume", "-r", "--resume-session-at", "--cd", "-C", "--add-dir"].includes(arg)) { index++; continue; }
    const flag = arg.split("=", 1)[0];
    if (valueFlags.has(flag)) {
      arguments_.push(arg);
      if (!arg.includes("=")) { const value = session.launchArguments[++index]; if (!value) throw new Error("來源設定缺少參數，沒有啟動新的工作階段。"); arguments_.push(value); }
    } else if (switches.has(arg)) arguments_.push(arg);
    else throw new Error("來源含有無法安全沿用的啟動參數，沒有重送原始指令。");
  }
  return { definitionId: session.definitionId, label: session.label, executable: session.executable,
    arguments: arguments_, workingDirectory: directory, resumeSessionId: null,
    profileConfigPath: session.profileConfigPath ?? null, sandbox: session.sandboxed, detached: session.detached,
    seedInput, restoreExistingSession: false, cols: 120, rows: 32 };
}
