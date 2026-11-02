/**
 * Recovering a saved relay entry whose address has moved.
 *
 * A free Cloudflare Quick Tunnel hands out a new hostname every time it
 * restarts, so an address saved with a device goes stale on its own and the
 * entry stops connecting. The saved address is only refreshed on a successful
 * connection, and a stale one never succeeds, so without a repair path the
 * entry can never fix itself.
 *
 * The decision is kept here rather than in the dialog so the rule — which
 * failures point at the address, and which corrected address is worth
 * storing — can be tested without a browser.
 */

/** The parts of a connect outcome this decision depends on. */
export type RelayConnectOutcome =
  | { outcome: "connected" }
  | { outcome: "failed"; stage: string };

export interface RelayConnectDecision {
  /** Show the address field, because the address is the likely fault. */
  offerAddressRepair: boolean;
  /** An address that just worked and differs from the stored one. */
  addressToSave: string | null;
}

export function relayConnectFollowUp({
  relayEntry,
  savedAddress,
  attemptedAddress,
  outcome,
}: {
  /** False for a direct entry, which has no relay address to repair. */
  relayEntry: boolean;
  savedAddress: string;
  attemptedAddress: string;
  outcome: RelayConnectOutcome;
}): RelayConnectDecision {
  if (!relayEntry) return { offerAddressRepair: false, addressToSave: null };

  if (outcome.outcome === "connected") {
    const working = attemptedAddress.trim();
    return {
      offerAddressRepair: false,
      // Only an address that actually carried a session is written back, so
      // a wrong guess can never replace one that was working.
      addressToSave: working && working !== savedAddress.trim() ? working : null,
    };
  }

  return {
    // An answering relay may still be a different relay from the host's,
    // or the host registration may be temporarily disconnected.
    offerAddressRepair: outcome.stage === "relay" || outcome.stage === "relayOffline",
    addressToSave: null,
  };
}
