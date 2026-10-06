import { launchedThroughCliProxy } from "./cliProxyApi";
import type { AgentLaunchRequest, AgentSessionSummary } from "./useAgentSessions";

/** The launch arguments with any model choice replaced by `model`. */
export function withModel(launchArguments: readonly string[], model: string): string[] {
  const kept: string[] = [];
  for (let index = 0; index < launchArguments.length; index += 1) {
    const argument = launchArguments[index];
    if (argument === "--model" || argument === "-m") {
      index += 1;
      continue;
    }
    if (argument.startsWith("--model=")) continue;
    kept.push(argument);
  }
  return [...kept, "--model", model];
}

/**
 * Claude Code changes model inside the running conversation with
 * `/model <name>`. Codex and Gemini only open an arrow-key menu there, so they
 * resume the same conversation on the new model instead.
 */
export function switchesModelInPlace(session: Pick<AgentSessionSummary, "definitionId">): boolean {
  return session.definitionId === "claude";
}

/**
 * The relaunch that resumes this session's conversation on another model, in
 * the same tab with the same account, proxy, folder and sandbox. `null` when
 * the CLI has not reported which conversation it is in yet.
 */
export function modelSwitchRequest(session: AgentSessionSummary, model: string): AgentLaunchRequest | null {
  if (!session.capturedSessionId) return null;
  return {
    definitionId: session.definitionId,
    label: session.label,
    executable: session.executable,
    // A proxy session keeps its connection arguments; anything else may only
    // carry the model when it resumes.
    arguments: launchedThroughCliProxy(session.launchArguments)
      ? withModel(session.launchArguments, model)
      : ["--model", model],
    resumeSessionId: session.capturedSessionId,
    groupId: session.groupId,
    restoreExistingSession: true,
    profileConfigPath: session.profileConfigPath ?? null,
    sandbox: session.sandboxed,
    detached: session.detached,
    workingDirectory: session.workingDirectory,
    cols: 120,
    rows: 32,
  };
}
