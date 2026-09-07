import type {
  AgentApi,
  AgentDefinition,
  AgentLaunchRequest,
  AgentSessionSummary,
} from "./useAgentSessions";

export type AgentRelocationContinuity =
  | "native"
  | "handoff"
  | "restart"
  | "unsupported";

export interface AgentRelocationSummary {
  native: number;
  handoff: number;
  restart: number;
  unsupported: number;
}

export interface AgentRelocationOutcome {
  sessions: AgentSessionSummary[];
  selectedSessionId: string;
  closeFailures: string[];
}

type RelocationApi = Pick<
  AgentApi,
  "launch" | "disconnect" | "exportTranscript"
>;

export function agentRelocationContinuity(
  session: AgentSessionSummary,
  definitions: readonly AgentDefinition[],
): AgentRelocationContinuity {
  if (session.definitionId === "custom") return "unsupported";
  const definition = definitions.find(
    (candidate) => candidate.id === session.definitionId,
  );
  if (!definition) return "unsupported";
  if (definition.resumeSupported && session.capturedSessionId) return "native";
  if (definition.transcriptSupported) return "handoff";
  return "restart";
}

export function summarizeAgentRelocation(
  sessions: readonly AgentSessionSummary[],
  definitions: readonly AgentDefinition[],
): AgentRelocationSummary {
  const summary: AgentRelocationSummary = {
    native: 0,
    handoff: 0,
    restart: 0,
    unsupported: 0,
  };
  for (const session of sessions) {
    summary[agentRelocationContinuity(session, definitions)] += 1;
  }
  return summary;
}

export async function relocateAgentSessionGroup({
  sessions,
  definitions,
  activeSessionId,
  workingDirectory,
  formatHandoff,
  api,
}: {
  sessions: readonly AgentSessionSummary[];
  definitions: readonly AgentDefinition[];
  activeSessionId: string;
  workingDirectory: string;
  formatHandoff: (transcript: string) => string;
  api: RelocationApi;
}): Promise<AgentRelocationOutcome> {
  if (sessions.length === 0) {
    throw new Error("The Agent session group is empty.");
  }
  const continuities = sessions.map((session) =>
    agentRelocationContinuity(session, definitions),
  );
  if (continuities.includes("unsupported")) {
    throw new Error("This Agent session cannot be safely restarted in another folder.");
  }

  const seeds = await Promise.all(
    sessions.map(async (session, index) => {
      if (continuities[index] !== "handoff") return null;
      const transcript = await api.exportTranscript(session.sessionId);
      if (!transcript?.trim()) {
        throw new Error(
          `No conversation history could be exported for ${session.label}.`,
        );
      }
      return formatHandoff(transcript);
    }),
  );

  const replacements: AgentSessionSummary[] = [];
  try {
    for (const [index, session] of sessions.entries()) {
      const request: AgentLaunchRequest = {
        definitionId: session.definitionId,
        label: session.label,
        executable: session.executable,
        arguments:
          continuities[index] === "native" ? [] : session.launchArguments,
        resumeSessionId:
          continuities[index] === "native"
            ? session.capturedSessionId
            : null,
        groupId: session.groupId,
        seedInput: seeds[index],
        // A relocation continues existing work and must not repeat the
        // workspace's new-session instructions before a resumed conversation.
        restoreExistingSession: true,
        profileConfigPath: session.profileConfigPath ?? null,
        workingDirectory,
        cols: 120,
        rows: 32,
      };
      replacements.push(await api.launch(request));
    }
  } catch (reason) {
    await Promise.allSettled(
      replacements.map((replacement) => api.disconnect(replacement.sessionId)),
    );
    throw reason;
  }

  const closeResults = await Promise.allSettled(
    sessions.map((session) => api.disconnect(session.sessionId)),
  );
  const closeFailures = sessions
    .filter((_, index) => closeResults[index].status === "rejected")
    .map((session) => session.sessionId);
  const activeIndex = Math.max(
    0,
    sessions.findIndex((session) => session.sessionId === activeSessionId),
  );
  return {
    sessions: replacements,
    selectedSessionId:
      replacements[activeIndex]?.sessionId ?? replacements[0].sessionId,
    closeFailures,
  };
}
