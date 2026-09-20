import { describe, expect, it } from "vitest";
import { shouldConnectWithoutAsking, type AutoConnectState } from "./remoteAutoConnect";

const saved: AutoConnectState = {
  relay: true,
  credentialMode: "saved",
  useSavedPairingCode: true,
  busy: false,
  failed: false,
  relayUnreachable: false,
  alreadyTried: false,
};

describe("connecting a saved host without asking", () => {
  it("starts when the pairing code is already stored", () => {
    expect(shouldConnectWithoutAsking(saved)).toBe(true);
  });

  it("asks whenever something is still missing or went wrong", () => {
    for (const change of [
      { relay: false },
      { credentialMode: "missing" as const },
      { credentialMode: "loading" as const },
      { useSavedPairingCode: false },
      { busy: true },
      { failed: true },
      { relayUnreachable: true },
      { alreadyTried: true },
    ]) {
      expect(shouldConnectWithoutAsking({ ...saved, ...change })).toBe(false);
    }
  });
});
