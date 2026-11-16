import { describe, expect, it } from "vitest";
import { createConnectionProfile, emptyDraft, mergeMachineCards } from "../domain/connection";
import { parseAndValidateImport, planProfileImport, serializeProfiles } from "../domain/export";
import { jumpGateways, legacyJumpCandidates, planLegacyJumpMerge } from "./jumpRoutes";
const profile = (id: string, hostname: string, name = "測試目標", username = "fixture") => createConnectionProfile({ ...emptyDraft("ssh"), hostname, username, name }, id);

describe("jump route metadata and conservative migration", () => {
  it("offers existing direct SSH gateways only", () => {
    const gateway = profile("gateway", "gateway.invalid", "跳板自訂名稱");
    expect(jumpGateways([gateway, { ...gateway, id: "self" }, { ...gateway, id: "chained", jumpProfileId: gateway.id }, { ...gateway, id: "rdp", protocol: "rdp" }, { ...gateway, id: "retired", retiredTo: "target" }], "self")).toEqual([gateway]);
  });
  it("requires an unambiguous non-loopback target with matching account and normalized names", () => {
    const target = profile("target", "target.invalid");
    const legacy = profile("legacy", "127.0.0.1", "測試目標（經自訂跳板）");
    expect(legacyJumpCandidates([target, legacy])).toEqual([{ legacy, target }]);
    for (const other of [{ ...target, username: "other" }, { ...target, name: "無關目標" }]) expect(legacyJumpCandidates([other, legacy])).toEqual([]);
    expect(legacyJumpCandidates([target, { ...target, id: "ambiguous" }, legacy])).toEqual([]);
    expect(legacyJumpCandidates([legacy])).toEqual([]);
  });
  it("retains legacy IDs and credentials, hides only confirmed entries and supports restoration", () => {
    const target = profile("target", "target.invalid"); const legacy = profile("legacy", "127.0.0.1", "測試目標 (via gateway)"); const gateway = profile("gateway", "gateway.invalid", "我的跳板");
    const original = [target, legacy, gateway]; const next = planLegacyJumpMerge(original, legacy.id, target.id, gateway.id);
    expect(next.map(entry => entry.id)).toEqual(original.map(entry => entry.id));
    expect(next[0].jumpProfileId).toBe(gateway.id); expect(next[1].retiredTo).toBe(target.id);
    expect(mergeMachineCards(next).map(card => card.profile.id)).toEqual([target.id, gateway.id]);
    expect(original[1].retiredTo).toBeUndefined();
    expect(mergeMachineCards(next.filter(entry => entry.id !== target.id)).some(card => card.profile.id === legacy.id)).toBe(true);
    expect(mergeMachineCards(next.map(entry => ({ ...entry, retiredTo: undefined })))).toHaveLength(3);
    expect(() => planLegacyJumpMerge(original, legacy.id, target.id, target.id)).toThrow();
  });
  it("exports only jump references and remaps imported gateway and retained IDs", () => {
    const gateway = profile("gateway", "gateway.invalid", "Gateway"); const target = { ...profile("target", "target.invalid"), jumpProfileId: gateway.id }; const legacy = { ...profile("legacy", "127.0.0.1"), retiredTo: target.id };
    const data = serializeProfiles([target, legacy, gateway]);
    expect(data).toContain('"jumpProfileId": "gateway"');
    const parsed = parseAndValidateImport(data.replace('"jumpProfileId": "gateway"', '"jumpProfileId": "gateway", "password":"discard", "jumpAuth":{"password":"discard"}'));
    const first = planProfileImport([], parsed.validProfiles);
    expect(first.next[0].jumpProfileId).toBe(first.next[2].id); expect(first.next[1].retiredTo).toBe(first.next[0].id);
    expect(JSON.stringify(first.next)).not.toContain("discard");
    const second = planProfileImport(first.next, parsed.validProfiles);
    expect(second.addedCount).toBe(0); expect(second.next).toEqual(first.next);
    const old = JSON.parse(data); old.profiles.forEach((entry: Record<string, unknown>) => { delete entry.jumpProfileId; delete entry.retiredTo; delete entry.id; });
    expect(parseAndValidateImport(JSON.stringify(old)).validProfiles).toHaveLength(3);
  });
});

it.each([
  ["出流管制", "出流管制SSH(經AI通道)"],
  ["X", "X (via Gateway)"],
  ["Synthetic Host", "synthetic host - ssh（THROUGH Gateway）"],
])("recognizes cross-protocol synthetic labels %s / %s", (name, oldName) => {
  const target = { ...profile("target", "192.0.2.10", name), protocol: "rdp" as const, port: 3389 };
  const legacy = { ...profile("legacy", "127.0.0.1", oldName), port: 14422 };
  const gateway = profile("gateway", "192.0.2.20", "Synthetic Gateway");
  expect(legacyJumpCandidates([target, legacy, gateway])).toEqual([{ legacy, target }]);
  expect(() => planLegacyJumpMerge([target, legacy, gateway], legacy.id, target.id, gateway.id)).toThrow();
  const merged = planLegacyJumpMerge([target, legacy, gateway], legacy.id, target.id, gateway.id, 2222);
  expect(merged[0]).toMatchObject({ id: "target", protocol: "rdp", port: 3389, machineId: "target" });
  expect(merged[1]).toMatchObject({ id: "legacy", hostname: "127.0.0.1", port: 14422, retiredTo: "target" });
  expect(merged[3]).toMatchObject({ protocol: "ssh", hostname: "192.0.2.10", port: 2222, jumpProfileId: "gateway", machineId: "target" });
  expect(mergeMachineCards(merged).find(card => card.profile.id === target.id)?.linked).toHaveLength(1);
});
it("reuses one same-protocol peer on the target machine and rejects ambiguous endpoints", () => {
  const target = { ...profile("target", "192.0.2.10", "Synthetic Host"), protocol: "rdp" as const, machineId: "machine" };
  const ssh = { ...profile("ssh", "192.0.2.10", "Synthetic Host SSH"), machineId: "machine", port: 2222 };
  const legacy = profile("legacy", "localhost", "Synthetic Host SSH (via Gateway)"); const gateway = profile("gateway", "192.0.2.20", "Gateway");
  const source = [target, ssh, legacy, gateway];
  expect(legacyJumpCandidates(source)).toEqual([{ legacy, target: ssh }]);
  const merged = planLegacyJumpMerge(source, legacy.id, ssh.id, gateway.id);
  expect(merged).toHaveLength(4); expect(merged[1].jumpProfileId).toBe(gateway.id);
  expect(legacyJumpCandidates([...source, { ...ssh, id: "second-ssh", hostname: "192.0.2.11" }])).toEqual([]);
});
it("allows two empty accounts only for a unique matching machine, without prefix guessing", () => {
  const target = profile("target", "192.0.2.10", "Synthetic Alpha", ""); const legacy = profile("legacy", "::1", "Synthetic Alpha SQL (via Gateway)", "");
  expect(legacyJumpCandidates([target, legacy])).toEqual([{ legacy, target }]);
  expect(legacyJumpCandidates([{ ...target, name: "Synthetic Alphabet" }, legacy])).toEqual([]);
});
