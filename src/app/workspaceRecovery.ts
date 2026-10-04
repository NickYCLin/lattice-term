import type { SavedAgentSession } from "./workspaceSessionPersistence";

export type WorkspaceRetryResult =
  | { status: "started" }
  | { status: "busy" }
  | { status: "failed"; detail: string };

export interface WorkspaceRecoveryProps {
  localProjectDirectories?: readonly string[];
  projectStorageError?: boolean;
  onRemoveLocalProject?: (path: string) => void;
  onRetryWorkspaceSession?: (session: SavedAgentSession) => Promise<WorkspaceRetryResult>;
  /** Drops a saved conversation that has not been started. */
  onDiscardWorkspaceSession?: (session: SavedAgentSession) => void;
  retryingWorkspace?: boolean;
  workspaceRecoveryError?: boolean;
}
