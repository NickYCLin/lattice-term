import { describe, expect, it } from "vitest";
import { createConnectionProfile, emptyDraft, mergeMachineCards, validateConnectionDraft } from "../domain/connection";
import { connectionAddressDrafts, validateAdditionalAddress } from "./connectionAddresses";
import { savedRouteProfiles } from "./connectionRoutes";

const draft = { ...emptyDraft(), name: "測試主機", hostname: "lan.example", username: "operator" };

describe("optional LAN and WAN addresses", () => {
  it("accepts either address alone, but still requires one usable address", () => {
    expect(connectionAddressDrafts(draft, "", "")).toEqual({ primary: draft, additional: undefined });
    const wanOnly = connectionAddressDrafts({ ...draft, hostname: "" }, "wan.example", "2222");
    expect(wanOnly.primary).toMatchObject({ hostname: "wan.example", port: 2222 });
    expect(wanOnly.additional).toBeUndefined();
    expect(validateConnectionDraft(wanOnly.primary)).toEqual({});
    const empty = connectionAddressDrafts({ ...draft, hostname: "" }, "  ", "");
    expect(validateConnectionDraft(empty.primary).hostname?.key).toBe("validation.hostRequired");
  });

  it("validates the second host and port only when an address is entered", () => {
    expect(validateAdditionalAddress(connectionAddressDrafts(draft, "", "-1").additional)).toEqual({});
    for (const hostname of ["https://wan.example", "bad host", "host/path"]) {
      expect(validateAdditionalAddress(connectionAddressDrafts(draft, hostname, "").additional).hostname).toBeDefined();
    }
    for (const port of ["0", "65536", "1.5", "NaN"]) {
      expect(validateAdditionalAddress(connectionAddressDrafts(draft, "wan.example", port).additional).port).toBeDefined();
    }
    expect(connectionAddressDrafts(draft, "wan.example", "").additional?.port).toBe(22);
  });

  it("saves both targets as distinct selectable routes and round-trips metadata without secrets", () => {
    const addresses = connectionAddressDrafts(draft, "wan.example", "2222");
    const primary = createConnectionProfile(addresses.primary, "lan");
    const additional = createConnectionProfile(addresses.additional!, "wan");
    const records = savedRouteProfiles([], primary, undefined, additional);
    expect(records.map(profile => [profile.hostname, profile.port, profile.machineId])).toEqual([
      ["lan.example", 22, "lan"], ["wan.example", 2222, "lan"],
    ]);
    const restored = JSON.parse(JSON.stringify(records));
    expect(mergeMachineCards(restored)).toEqual([{ profile: records[0], linked: [records[1]] }]);
    expect(savedRouteProfiles(records, { ...records[1], hostname: "new-wan.example" })[0]).toEqual(records[0]);
    expect(() => savedRouteProfiles(records, primary, undefined, additional)).toThrow();
    expect(records[1].hostname).toBe("wan.example");
  });

  it("does not add a stale address to a relay device", () => {
    const relay = { ...emptyDraft("lattice"), deviceId: "123456789" };
    expect(connectionAddressDrafts(relay, "wan.example", "2222")).toEqual({ primary: relay, additional: undefined });
  });

  it("accepts an IPv6 address without treating its colons as a port", () => {
    const addresses = connectionAddressDrafts(draft, "2001:db8::42", "2222");
    expect(validateAdditionalAddress(addresses.additional)).toEqual({});
    expect(createConnectionProfile(addresses.additional!, "ipv6")).toMatchObject({
      hostname: "2001:db8::42", port: 2222,
    });
    const only = connectionAddressDrafts({ ...draft, hostname: "" }, "2001:db8::42", "");
    expect(validateConnectionDraft(only.primary)).toEqual({});
    expect(only.primary.port).toBe(22);
  });
});
