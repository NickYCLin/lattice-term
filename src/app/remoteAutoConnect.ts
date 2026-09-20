/**
 * Whether a saved host can connect without asking anything. The dialog exists
 * to collect a pairing code; when the code is already in the credential store
 * there is nothing to collect, so the connection starts by itself.
 */
export interface AutoConnectState {
  relay: boolean;
  credentialMode: "saved" | "missing" | "loading" | "unavailable";
  useSavedPairingCode: boolean;
  busy: boolean;
  /** A failure hands the decision back to the person. */
  failed: boolean;
  relayUnreachable: boolean;
  alreadyTried: boolean;
}

export function shouldConnectWithoutAsking(state: AutoConnectState): boolean {
  return (
    state.relay &&
    state.credentialMode === "saved" &&
    state.useSavedPairingCode &&
    !state.busy &&
    !state.failed &&
    !state.relayUnreachable &&
    !state.alreadyTried
  );
}
