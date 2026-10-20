import { describe, expect, it } from "vitest";
import { createConnectionProfile, emptyDraft, protocolCatalog } from "../domain/connection";
import { cardRouteProfiles, newRouteDraft, savedRouteProfiles } from "./connectionRoutes";

const source = createConnectionProfile({ ...emptyDraft(), name: "合成主機", hostname: "fixture.invalid", username: "fixture" }, "ssh-route");

describe("same-machine route records", () => {
  it("collects the whole card across groups and addresses but excludes unrelated hosts", () => {
    const primary = { ...source, machineId: "machine" };
    const secondary = { ...primary, id: "wan", hostname: "wan.invalid", group: "Other group" };
    const unrelated = { ...source, id: "other", machineId: "another-machine" };
    expect(cardRouteProfiles([primary, secondary, unrelated], secondary.id)).toEqual([secondary, primary]);
    expect(cardRouteProfiles([source, { ...source, id: "same-host" }], source.id)).toEqual([source]);
    expect(cardRouteProfiles([source], "missing")).toEqual([]);
  });
  it("adds the requested RDP protocol without inheriting the custom SSH port", () => {
    const original = { ...source, port: 2222 };
    const draft = newRouteDraft(original, [original], "rdp");
    expect(draft).toMatchObject({ protocol: "rdp", port: 3389, machineId: original.id });
    const records = savedRouteProfiles([original], createConnectionProfile(draft, "rdp-route"), original.id);
    expect(records[0]).toEqual({ ...original, machineId: original.id });
    expect(records[1].port).toBe(3389);
  });

  it("starts a separate protocol with default parameters and no inherited remote identity", () => {
    const draft = newRouteDraft({ ...source, port: 2222, deviceId: "synthetic-device", relayAddress: "synthetic-relay" }, [source]);
    expect(draft).toMatchObject({ protocol: "sftp", hostname: source.hostname, port: 22, machineId: source.id });
    expect(draft.deviceId).toBeFalsy();
    expect(draft.relayAddress).toBeFalsy();
    const newProfile = createConnectionProfile(draft, "sftp-route");
    const records = savedRouteProfiles([source], newProfile, source.id);
    expect(records[0]).toEqual({ ...source, machineId: source.id });
    expect(records[1]).toEqual(newProfile);
    expect(records[0].protocol).toBe("ssh");
  });

  it("offers the next unused protocol without replacing existing routes", () => {
    const profiles = protocolCatalog.map(entry => ({ ...source, id: entry.id, protocol: entry.id, machineId: "machine" }));
    for (const count of [1, 2, 3, 4]) {
      expect(newRouteDraft(profiles[0], profiles.slice(0, count)).protocol).toBe(protocolCatalog[count].id);
    }
    expect(newRouteDraft(profiles[0], profiles).protocol).toBe(profiles[0].protocol);
  });

  it("preserves existing group identity, route parameters, and list order on edit", () => {
    const linkedSource = { ...source, machineId: "old-machine" };
    const route = createConnectionProfile(newRouteDraft(linkedSource, [linkedSource]), "new-route");
    const unrelated = { ...source, id: "unrelated" };
    const records = savedRouteProfiles([linkedSource, unrelated], route, source.id);
    expect(records[0]).toEqual(linkedSource);
    expect(records[1]).toEqual(unrelated);
    const edited = { ...route, username: "another-user", port: 2223 };
    expect(savedRouteProfiles(records, edited)).toEqual([linkedSource, unrelated, edited]);
  });

  it("rejects a missing source, self-link or repeated save identity without mutating records", () => {
    const records = [source];
    const before = JSON.stringify(records);
    expect(() => savedRouteProfiles(records, { ...source, id: "new" }, "missing")).toThrow();
    expect(() => savedRouteProfiles(records, source, source.id)).toThrow();
    expect(() => savedRouteProfiles([source, { ...source, id: "new" }], { ...source, id: "new" }, source.id)).toThrow();
    expect(JSON.stringify(records)).toBe(before);
  });
});
