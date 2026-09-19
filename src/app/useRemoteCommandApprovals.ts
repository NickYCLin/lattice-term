/**
 * Commands an MCP client proposed for a shared SSH connection.
 *
 * The desktop pushes the waiting list because the card has to appear wherever
 * the user happens to be, not only in Settings. Nothing runs until an answer
 * goes back, so a window that never renders is a refusal, not a bypass.
 */

import { useCallback, useEffect, useState } from "react";
import { hasDesktopBackend } from "./nativeRuntime";

export interface PendingRemoteCommand {
  operationId: string;
  targetId: string;
  targetLabel: string;
  client: string;
  command: string;
  timeoutMs: number;
  expiresInMs: number;
}

export function useRemoteCommandApprovals() {
  const [pending, setPending] = useState<PendingRemoteCommand[]>([]);

  useEffect(() => {
    if (!hasDesktopBackend()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const [{ invoke }, { listen }] = await Promise.all([
        import("@tauri-apps/api/core"),
        import("@tauri-apps/api/event"),
      ]);
      const dispose = await listen<PendingRemoteCommand[]>(
        "mcp://command-approvals",
        ({ payload }) => {
          if (!cancelled) setPending(payload);
        },
      );
      if (cancelled) {
        dispose();
        return;
      }
      unlisten = dispose;
      // A window that opened while something was already waiting still has
      // to show it; the event alone would only cover later changes.
      const already = await invoke<PendingRemoteCommand[]>("mcp_remote_pending_commands");
      if (!cancelled) setPending((shown) => (shown.length > 0 ? shown : already));
    })().catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const decide = useCallback(async (operationId: string, approve: boolean) => {
    const { invoke } = await import("@tauri-apps/api/core");
    const rest = await invoke<PendingRemoteCommand[]>("mcp_remote_command_decide", {
      operationId,
      approve,
    });
    setPending(rest);
  }, []);

  return { pending, decide };
}
