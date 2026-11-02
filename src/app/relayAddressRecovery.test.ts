import { describe, expect, it } from "vitest";
import { relayConnectFollowUp } from "./relayAddressRecovery";

const saved = "wss://old.example.com";

describe("relayConnectFollowUp", () => {
  it("offers to fix the address when the relay never answered", () => {
    expect(
      relayConnectFollowUp({
        relayEntry: true,
        savedAddress: saved,
        attemptedAddress: saved,
        outcome: { outcome: "failed", stage: "relay" },
      }),
    ).toEqual({ offerAddressRepair: true, addressToSave: null });
  });

  it("offers to compare the relay when the device is not registered there", () => {
    expect(relayConnectFollowUp({ relayEntry: true, savedAddress: saved, attemptedAddress: saved,
      outcome: { outcome: "failed", stage: "relayOffline" } })).toEqual({ offerAddressRepair: true, addressToSave: null });
  });

  it("leaves the address alone for unrelated failures", () => {
    for (const stage of ["connect", "pairing", "pinning", "session"]) {
      expect(
        relayConnectFollowUp({
          relayEntry: true,
          savedAddress: saved,
          attemptedAddress: saved,
          outcome: { outcome: "failed", stage },
        }).offerAddressRepair,
      ).toBe(false);
    }
  });

  it("stores an address that carried a real session", () => {
    expect(
      relayConnectFollowUp({
        relayEntry: true,
        savedAddress: saved,
        attemptedAddress: "  wss://new.example.com  ",
        outcome: { outcome: "connected" },
      }),
    ).toEqual({
      offerAddressRepair: false,
      addressToSave: "wss://new.example.com",
    });
  });

  it("writes nothing when the address that worked is the saved one", () => {
    expect(
      relayConnectFollowUp({
        relayEntry: true,
        savedAddress: saved,
        attemptedAddress: `  ${saved}  `,
        outcome: { outcome: "connected" },
      }).addressToSave,
    ).toBeNull();
  });

  it("never stores an address that failed", () => {
    expect(
      relayConnectFollowUp({
        relayEntry: true,
        savedAddress: saved,
        attemptedAddress: "wss://a-guess.example.com",
        outcome: { outcome: "failed", stage: "relay" },
      }).addressToSave,
    ).toBeNull();
  });

  it("never stores an empty address", () => {
    expect(
      relayConnectFollowUp({
        relayEntry: true,
        savedAddress: saved,
        attemptedAddress: "   ",
        outcome: { outcome: "connected" },
      }).addressToSave,
    ).toBeNull();
  });

  it("does nothing for a direct entry, which has no relay to repair", () => {
    expect(
      relayConnectFollowUp({
        relayEntry: false,
        savedAddress: "",
        attemptedAddress: "",
        outcome: { outcome: "failed", stage: "relay" },
      }),
    ).toEqual({ offerAddressRepair: false, addressToSave: null });
  });
});
