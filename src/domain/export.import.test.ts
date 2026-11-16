import { describe, expect, it } from "vitest";
import { createConnectionProfile, emptyDraft, mergeMachineCards } from "./connection";
import { parseAndValidateImport, planProfileImport, serializeProfiles } from "./export";
const ssh = createConnectionProfile({ ...emptyDraft("ssh"), name: "Fixture", hostname: "host.invalid", username: "operator", group: "group", tags: ["tag"], favorite: true }, "local-ssh");
const parse = (profiles: unknown[]) => parseAndValidateImport(JSON.stringify({ version: 1, application: "LatticeTerm", profiles })).validProfiles;

describe("connection import planning", () => {
  it("exports stable IDs and overwrites every entry on an unchanged round trip", () => {
    const existing = [ssh, { ...ssh, id: "rdp", protocol: "rdp" as const, port: 3389 }];
    const exported = serializeProfiles(existing);
    expect(JSON.parse(exported).profiles.map((p: { id: string }) => p.id)).toEqual(["local-ssh", "rdp"]);
    const plan = planProfileImport(existing, parseAndValidateImport(exported).validProfiles);
    expect(plan.addedCount).toBe(0); expect(plan.overwrittenCount).toBe(2);
    expect(plan.next).toEqual(existing); expect(plan.conflicts).toEqual([]);
  });
  it("updates names, groups, tags, favorites and environment without adding identities", () => {
    const plan = planProfileImport([ssh], parse([{ ...ssh, name: "Renamed", group: "new group", tags: ["new"], favorite: false, environment: "staging" }]));
    expect(plan.addedCount).toBe(0); expect(plan.overwrittenCount).toBe(1);
    expect(plan.next[0]).toMatchObject({ id: ssh.id, name: "Renamed", group: "new group", tags: ["new"], favorite: false, environment: "staging" });
  });
  it("imports an older ID-less file repeatedly without growing the list", () => {
    const { id: _, ...legacy } = ssh;
    const first = planProfileImport([], parse([legacy]));
    expect(first.addedCount).toBe(1);
    const second = planProfileImport(first.next, parse([legacy]));
    const third = planProfileImport(second.next, parse([legacy]));
    expect(second.addedCount).toBe(0); expect(third.addedCount).toBe(0);
    expect(third.next.map(p => p.id)).toEqual(first.next.map(p => p.id));
  });
  it("prioritizes a local ID even when the imported endpoint and protocol change", () => {
    const plan = planProfileImport([ssh], parse([{ ...ssh, protocol: "sftp", hostname: "other.invalid", username: "other", port: 2222 }]));
    expect(plan.addedCount).toBe(0); expect(plan.overwrittenCount).toBe(1);
    expect(plan.next[0]).toMatchObject({ id: ssh.id, protocol: "sftp", hostname: "other.invalid", port: 2222, username: "other" });
  });
  it("falls back from a foreign ID to case-insensitive host and trimmed username", () => {
    const plan = planProfileImport([ssh], parse([{ ...ssh, id: "foreign-id", hostname: "HOST.INVALID", username: " operator " }]));
    expect(plan.addedCount).toBe(0); expect(plan.overwrittenCount).toBe(1);
    expect(plan.next[0].id).toBe(ssh.id);
  });
  it.each([
    { username: "different" }, { username: "Operator" }, { protocol: "sftp" }, { port: 2222 },
  ])("adds a distinct target when identity metadata differs: %j", changed => {
    const plan = planProfileImport([ssh], parse([{ ...ssh, ...changed, id: "foreign" }]));
    expect(plan.addedCount).toBe(1); expect(plan.overwrittenCount).toBe(0); expect(plan.next).toHaveLength(2);
    expect(plan.next[1].id).not.toBe("foreign"); expect(plan.next[1].id).not.toBe(ssh.id);
  });
  it("matches relayed Lattice Remote by deviceId instead of hostname, user or relay address", () => {
    const relay = createConnectionProfile({ ...emptyDraft("lattice"), name: "Relay", deviceId: "018536454", relayAddress: "wss://relay.invalid" }, "relay-local");
    const plan = planProfileImport([relay], parse([{ ...relay, id: "other-id", relayAddress: "wss://other.invalid", name: "Renamed relay" }]));
    expect(plan.addedCount).toBe(0); expect(plan.next[0]).toMatchObject({ id: relay.id, name: "Renamed relay", relayAddress: "wss://other.invalid" });
  });
  it("applies the last row once per existing identity even after an earlier row changes its target", () => {
    const plan = planProfileImport([ssh], parse([{ ...ssh, hostname: "changed.invalid", name: "first" }, { ...ssh, id: undefined, name: "last" }]));
    expect(plan.overwrittenCount).toBe(1); expect(plan.changes).toHaveLength(1);
    expect(plan.next[0]).toMatchObject({ id: ssh.id, hostname: ssh.hostname, name: "last" });
  });
  it("collapses duplicates within a new file and never adopts a foreign ID", () => {
    const plan = planProfileImport([], parse([{ ...ssh, id: "foreign", name: "first" }, { ...ssh, id: "foreign", hostname: "changed.invalid", name: "last" }]));
    expect(plan.addedCount).toBe(1); expect(plan.next).toHaveLength(1); expect(plan.next[0].name).toBe("last");
    expect(plan.next[0].id).not.toBe("foreign");
    const idless = planProfileImport([], parse([{ ...ssh, id: undefined }, { ...ssh, id: undefined, name: "last" }]));
    expect(idless.addedCount).toBe(1); expect(idless.next[0].name).toBe("last");
  });
  it("never exports or accepts secrets or unrelated database/tunnel metadata", () => {
    const injected = { ...ssh, password: "test-only-excluded", privateKey: "test-only-excluded", pairingCode: "test-only-excluded", passphrase: "test-only-excluded", tlsCaPem: "test-only-excluded", tunnels: [] };
    const exported = serializeProfiles([injected]);
    expect(exported).not.toContain("test-only-excluded");
    const profiles = parse([injected]);
    const plan = planProfileImport([ssh], profiles);
    expect(JSON.stringify(profiles)).not.toContain("test-only-excluded");
    expect(plan.next).toEqual([ssh]);
    expect(plan.changes[0].profile.id).toBe(ssh.id);
  });
  it("does not duplicate routes on a machine card after reimport", () => {
    const existing = [{ ...ssh, machineId: "machine" }, { ...ssh, id: "rdp", protocol: "rdp" as const, port: 3389, machineId: "machine" }];
    const plan = planProfileImport(existing, parseAndValidateImport(serializeProfiles(existing)).validProfiles);
    const cards = mergeMachineCards(plan.next);
    expect(plan.addedCount).toBe(0); expect(cards).toHaveLength(1); expect(cards[0].linked).toHaveLength(1);
    expect(new Set([cards[0].profile.id, ...cards[0].linked.map(p => p.id)]).size).toBe(2);
  });
  it("blocks ID retargeting that would produce a duplicate instead of deleting another local identity", () => {
    const second = { ...ssh, id: "second", hostname: "second.invalid" };
    const plan = planProfileImport([ssh, second], parse([{ ...ssh, hostname: second.hostname }]));
    expect(plan.conflicts).toHaveLength(2);
    expect(plan.next.map(p => p.id)).toEqual([ssh.id, second.id]);
  });
});

it("keeps local jump and retained-card references when importing pre-route exports", () => {
  const gateway = { ...ssh, id: "gateway", hostname: "192.0.2.20", name: "Synthetic Gateway" };
  const target = { ...ssh, jumpProfileId: gateway.id };
  const legacy = { ...ssh, id: "legacy", hostname: "127.0.0.1", port: 14422, retiredTo: target.id };
  const plan = planProfileImport([target, legacy, gateway], parse([{ ...ssh }, { ...legacy, retiredTo: undefined }, gateway]));
  expect(plan.next).toEqual([target, legacy, gateway]);
  expect(plan.routeChanges).toEqual([]); expect(plan.routeWarnings).toEqual([]);
});
it.each([null, ""])("clears local routes only when the file explicitly supplies %s", clear => {
  const gateway = { ...ssh, id: "gateway", hostname: "192.0.2.20" };
  const target = { ...ssh, jumpProfileId: gateway.id };
  const legacy = { ...ssh, id: "legacy", hostname: "127.0.0.1", port: 14422, retiredTo: target.id };
  const plan = planProfileImport([target, legacy, gateway], parse([{ ...target, jumpProfileId: clear }, { ...legacy, retiredTo: clear }]));
  expect(plan.next[0].jumpProfileId).toBeUndefined(); expect(plan.next[1].retiredTo).toBeUndefined();
  expect(plan.routeChanges).toEqual([
    { profileId: target.id, name: target.name, field: "jumpProfileId", before: gateway.id, after: undefined },
    { profileId: legacy.id, name: legacy.name, field: "retiredTo", before: target.id, after: undefined },
  ]);
});
it("previews changed references and clears dangling imported references with named warnings", () => {
  const gateway = { ...ssh, id: "gateway", hostname: "192.0.2.20" }, other = { ...gateway, id: "other", hostname: "192.0.2.21" };
  const target = { ...ssh, jumpProfileId: gateway.id };
  const changed = planProfileImport([target, gateway, other], parse([{ ...target, jumpProfileId: other.id }]));
  expect(target.jumpProfileId).toBe(gateway.id);
  expect(changed.routeChanges[0]).toMatchObject({ field: "jumpProfileId", before: gateway.id, after: other.id });
  expect(changed.next[0].jumpProfileId).toBe(other.id);
  const dangling = planProfileImport([target, gateway], parse([{ ...target, jumpProfileId: "missing-gateway", retiredTo: "missing-target" }]));
  expect(dangling.next[0].jumpProfileId).toBeUndefined(); expect(dangling.next[0].retiredTo).toBeUndefined();
  expect(dangling.routeWarnings.map(warning => [warning.name, warning.reference])).toEqual([[target.name, "missing-gateway"], [target.name, "missing-target"]]);
});
it("keeps the latest explicit route setting when later duplicate rows omit route fields", () => {
  const gateway = { ...ssh, id: "gateway", hostname: "192.0.2.20" };
  const plan = planProfileImport([ssh, gateway], parse([{ ...ssh, jumpProfileId: gateway.id }, { ...ssh, name: "Final synthetic name" }]));
  expect(plan.next[0].jumpProfileId).toBe(gateway.id); expect(plan.routeChanges).toHaveLength(1); expect(plan.changes).toHaveLength(1);
});
