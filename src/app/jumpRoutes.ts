import type { ConnectionProfile } from "../domain/connection";
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
function baseName(name: string) { return name.normalize("NFKC").toLowerCase().replace(/[（(].*?[）)]/g, "").replace(/(?:經|via|through)\s*.*$/i, "").replace(/[\s_-]+/g, ""); }
export function legacyJumpCandidates(profiles: readonly ConnectionProfile[]) {
  return profiles.filter(profile => loopback(profile.hostname) && !profile.retiredTo).flatMap(legacy => {
    const name = baseName(legacy.name);
    const targets = profiles.filter(target => target.id !== legacy.id && !target.retiredTo && !loopback(target.hostname) && target.hostname.trim()
      && target.protocol === legacy.protocol && target.username.trim() === legacy.username.trim() && name && baseName(target.name) === name);
    // Ambiguous or missing real targets are deliberately left alone.
    return targets.length === 1 ? [{ legacy, target: targets[0] }] : [];
  });
}
export function planLegacyJumpMerge(profiles: readonly ConnectionProfile[], legacyId: string, targetId: string, gatewayId: string) {
  const candidate = legacyJumpCandidates(profiles).find(entry => entry.legacy.id === legacyId && entry.target.id === targetId);
  if (!candidate || gatewayId === legacyId || !jumpGateways(profiles, targetId).some(entry => entry.id === gatewayId) || candidate.target.jumpProfileId && candidate.target.jumpProfileId !== gatewayId) throw new Error("jump.migration.invalid");
  return profiles.map(profile => profile.id === targetId ? { ...profile, jumpProfileId: gatewayId }
    : profile.id === legacyId ? { ...profile, retiredTo: targetId } : profile);
}

export function jumpError(detail: string, t: (key: "jump.error.gateway" | "jump.error.target") => string): string {
  return detail.startsWith("jump:") ? t("jump.error.gateway") : detail.startsWith("target:") ? t("jump.error.target") : detail;
}
