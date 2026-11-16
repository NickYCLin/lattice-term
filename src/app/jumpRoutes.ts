import { createConnectionProfile, draftFromProfile, findProtocol, type ConnectionProfile } from "../domain/connection";
import type { SshAuth } from "./useSshSessions";

/** Runtime-only authentication. Never serialize into connection metadata. */
export interface JumpRequest { profileId: string; auth?: SshAuth; useSavedPassword: boolean; rememberPassword: boolean }
export type ConnectionAttemptProfile = ConnectionProfile & { jump?: JumpRequest };
export function jumpGateways(profiles: readonly ConnectionProfile[], targetId?: string) {
  return profiles.filter(profile => profile.protocol === "ssh" && profile.id !== targetId && !profile.jumpProfileId && !profile.retiredTo);
}
export function activeConnectionProfiles(profiles: readonly ConnectionProfile[]) {
  return profiles.filter(entry => !entry.retiredTo || !profiles.some(target => target.id === entry.retiredTo && target.id !== entry.id && !target.retiredTo));
}
const loopback = (host: string) => /^(127\.0\.0\.1|localhost|\[?::1\]?)$/i.test(host.trim());
/** Strip route annotations and trailing protocol tokens; compare exact normalized bases.
 * No arbitrary prefix matching: short names must not merge unrelated machines. */
function baseName(name: string) {
  return name.normalize("NFKC").toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/(?:\s|[-_:|/])+(?:經|via\b|through\b).*$/iu, "")
    .replace(/(?:[\s._:/|\-]*(?:sftp|ssh|rdp|vnc|sql))+\s*$/iu, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}
export function legacyJumpCandidates(profiles: readonly ConnectionProfile[]) {
  return profiles.filter(profile => loopback(profile.hostname) && !profile.retiredTo).flatMap(legacy => {
    const name = baseName(legacy.name);
    const targets = profiles.filter(target => target.id !== legacy.id && !target.retiredTo && !loopback(target.hostname) && target.hostname.trim()
      && target.protocol !== "lattice" && target.username.trim() === legacy.username.trim() && name && baseName(target.name) === name);
    const machines = new Map<string, ConnectionProfile[]>();
    for (const target of targets) {
      const key = target.machineId ?? target.id;
      machines.set(key, [...machines.get(key) ?? [], target]);
    }
    if (machines.size !== 1) return [];
    const matched = [...machines.values()][0];
    const key = matched[0].machineId ?? matched[0].id;
    const sameProtocol = profiles.filter(target => (target.machineId ?? target.id) === key && target.protocol === legacy.protocol
      && !target.retiredTo && !loopback(target.hostname) && target.hostname.trim() && target.username.trim() === legacy.username.trim());
    // Multiple endpoints for the same protocol need a human decision outside this merge.
    if (sameProtocol.length > 1) return [];
    return [{ legacy, target: sameProtocol[0] ?? matched[0] }];
  });
}
export function planLegacyJumpMerge(profiles: readonly ConnectionProfile[], legacyId: string, targetId: string, gatewayId: string, targetPort?: number) {
  const candidate = legacyJumpCandidates(profiles).find(entry => entry.legacy.id === legacyId && entry.target.id === targetId);
  if (!candidate || gatewayId === legacyId || !jumpGateways(profiles, targetId).some(entry => entry.id === gatewayId)) throw new Error("jump.migration.invalid");
  if (candidate.target.protocol === candidate.legacy.protocol) {
    if (candidate.target.jumpProfileId && candidate.target.jumpProfileId !== gatewayId) throw new Error("jump.migration.invalid");
    return profiles.map(profile => profile.id === targetId ? { ...profile, jumpProfileId: gatewayId }
      : profile.id === legacyId ? { ...profile, retiredTo: targetId } : profile);
  }
  if (!Number.isInteger(targetPort) || targetPort! < 1 || targetPort! > 65535) throw new Error("jump.migration.invalid");
  const { target, legacy } = candidate;
  if (profiles.some(profile => !profile.retiredTo && profile.protocol === legacy.protocol && profile.hostname.toLowerCase() === target.hostname.toLowerCase()
    && profile.port === targetPort && profile.username.trim() === legacy.username.trim())) throw new Error("jump.migration.invalid");
  const machineId = target.machineId ?? target.id;
  const route = createConnectionProfile({ ...draftFromProfile(legacy), name: `${target.name} · ${findProtocol(legacy.protocol).acronym}`,
    hostname: target.hostname, port: targetPort!, machineId, jumpProfileId: gatewayId, retiredTo: undefined });
  return [...profiles.map(profile => profile.id === targetId ? { ...profile, machineId }
    : profile.id === legacyId ? { ...profile, retiredTo: targetId } : profile), route];
}

export function jumpError(detail: string, t: (key: "jump.error.gateway" | "jump.error.target") => string): string {
  return detail.startsWith("jump:") ? t("jump.error.gateway") : detail.startsWith("target:") ? t("jump.error.target") : detail;
}
