/** Shared send-gate for native conversation history. */
export const NATIVE_HISTORY_GATE_CODE = "history.sendBlocked";

export class NativeHistoryGateError extends Error {
  readonly code = NATIVE_HISTORY_GATE_CODE;
  readonly reason: string | null;
  constructor(reason?: string | null) {
    super(NATIVE_HISTORY_GATE_CODE);
    this.name = "NativeHistoryGateError";
    this.reason = reason ?? null;
  }
}

export function nativeHistoryReadyKey(
  threadId: string,
  nativeSessionId: string | null | undefined,
  accountProfileId: string | null | undefined,
  profileKey: string,
) {
  return JSON.stringify([threadId, nativeSessionId, accountProfileId, profileKey]);
}
