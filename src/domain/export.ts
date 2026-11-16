/**
 * Safe connection export and import.
 *
 * Strictly non-secret: the format carries hostname, port, protocol,
 * environment, group and tags only. Secrets belong to the OS credential store
 * and are neither written nor accepted here.
 *
 * Problems are reported as message keys so the file can be imported in any
 * language and still explain itself.
 */

import {
  UNGROUPED,
  isRelayProfile,
  createConnectionProfile,
  emptyDraft,
  parseTags,
  protocolCatalog,
  validateConnectionDraft,
  type ConnectionDraft,
  type ConnectionProfile,
  type Environment,
  type Protocol,
  type ValidationIssue,
} from "./connection";
import type { MessageKey } from "../i18n/messages/zh-TW";

export const EXPORT_SCHEMA_VERSION = 1;

export interface LatticeTermExport {
  version: number;
  exportedAt: string;
  application: "LatticeTerm";
  profiles: (ConnectionDraft & { id?: string })[];
}

export interface ImportIssue {
  key: MessageKey;
  values?: Record<string, string | number>;
  /** Field-level reasons, rendered into the entry's message by the caller. */
  fieldIssues?: ValidationIssue[];
}

export interface ImportResult {
  validProfiles: ImportedProfile[];
  issues: ImportIssue[];
  skippedCount: number;
}

/** Serialises connection entries to a clean, non-secret JSON string. */
export function serializeProfiles(
  profiles: ConnectionProfile[],
  exportedAt: string = new Date().toISOString(),
): string {
  const exportData: LatticeTermExport = {
    version: EXPORT_SCHEMA_VERSION,
    exportedAt,
    application: "LatticeTerm",
    profiles: profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      protocol: profile.protocol,
      hostname: profile.hostname,
      username: profile.username,
      port: profile.port,
      environment: profile.environment,
      group: profile.group === UNGROUPED ? "" : profile.group,
      tags: profile.tags,
      favorite: profile.favorite,
      // Only relay entries carry these, and both are addressing metadata
      // rather than secrets, so they travel with the rest of the entry.
      ...(profile.deviceId ? { deviceId: profile.deviceId } : {}),
      ...(profile.relayAddress ? { relayAddress: profile.relayAddress } : {}),
      ...(profile.machineId ? { machineId: profile.machineId } : {}),
      ...(profile.jumpProfileId ? { jumpProfileId: profile.jumpProfileId } : {}),
      ...(profile.retiredTo ? { retiredTo: profile.retiredTo } : {}),
    })),
  };

  return JSON.stringify(exportData, null, 2);
}

const knownEnvironments = new Set<Environment>([
  "production",
  "staging",
  "development",
]);

/**
 * Parses an exported file. Invalid entries are skipped and reported rather
 * than dropped silently, so an import never claims more than it did.
 */
export function parseAndValidateImport(jsonContent: string): ImportResult {
  const issues: ImportIssue[] = [];
  const validProfiles: ImportedProfile[] = [];
  let skippedCount = 0;

  let raw: unknown;
  try {
    raw = JSON.parse(jsonContent);
  } catch {
    return {
      validProfiles: [],
      issues: [{ key: "transfer.error.json" }],
      skippedCount: 0,
    };
  }

  if (typeof raw !== "object" || raw === null) {
    return {
      validProfiles: [],
      issues: [{ key: "transfer.error.notObject" }],
      skippedCount: 0,
    };
  }

  const data = raw as Partial<LatticeTermExport>;

  if (typeof data.application === "string" && data.application !== "LatticeTerm") {
    issues.push({
      key: "transfer.error.foreignApp",
      values: { app: data.application },
    });
  }

  const rawProfiles = Array.isArray(data.profiles)
    ? data.profiles
    : Array.isArray(raw)
      ? raw
      : null;

  if (!rawProfiles) {
    return {
      validProfiles: [],
      issues: [...issues, { key: "transfer.error.noProfiles" }],
      skippedCount: 0,
    };
  }

  const validProtocols = new Set<string>(protocolCatalog.map((p) => p.id));

  rawProfiles.forEach((item, index) => {
    const entryIndex = index + 1;

    if (typeof item !== "object" || item === null) {
      issues.push({
        key: "transfer.error.notObjectItem",
        values: { index: entryIndex },
      });
      skippedCount += 1;
      return;
    }

    const record = item as Record<string, unknown>;
    const name = String(record.name ?? "").trim();
    const protocol = String(record.protocol ?? "ssh").toLowerCase();

    if (!validProtocols.has(protocol)) {
      issues.push({
        key: "transfer.error.unknownProtocol",
        values: { index: entryIndex, name, protocol },
      });
      skippedCount += 1;
      return;
    }

    const environment = record.environment;
    const draft: ConnectionDraft = {
      ...emptyDraft(protocol as Protocol),
      name,
      protocol: protocol as Protocol,
      hostname: String(record.hostname ?? "").trim(),
      username: String(record.username ?? "").trim(),
      port:
        typeof record.port === "number"
          ? record.port
          : Number(record.port ?? emptyDraft(protocol as Protocol).port),
      environment:
        typeof environment === "string" &&
        knownEnvironments.has(environment as Environment)
          ? (environment as Environment)
          : "unassigned",
      group: typeof record.group === "string" ? record.group.trim() : "",
      tags: parseTags(
        Array.isArray(record.tags)
          ? (record.tags as string[]).map(String)
          : typeof record.tags === "string"
            ? record.tags
            : [],
      ),
      favorite: Boolean(record.favorite),
      ...(typeof record.deviceId === "string"
        ? { deviceId: record.deviceId }
        : {}),
      ...(typeof record.relayAddress === "string"
        ? { relayAddress: record.relayAddress }
        : {}),
      ...(typeof record.jumpProfileId === "string" ? { jumpProfileId: record.jumpProfileId } : {}),
      ...(typeof record.retiredTo === "string" ? { retiredTo: record.retiredTo } : {}),
      ...(typeof record.machineId === "string"
        ? { machineId: record.machineId }
        : {}),
    };

    const validation = validateConnectionDraft(draft);
    const fieldIssues = Object.values(validation);

    if (fieldIssues.length > 0) {
      issues.push({
        key: "transfer.error.invalidEntry",
        values: { index: entryIndex, name },
        fieldIssues,
      });
      skippedCount += 1;
      return;
    }

    // Normalize only whitelisted fields; UUIDs belong to new local entries,
    // not parsing. A foreign id is a matching hint, never a new local identity.
    const { id: _id, ...profile } = createConnectionProfile(draft, "");
    const id = typeof record.id === "string" && record.id.trim().length <= 256
      && !/[\x00-\x1f\x7f]/.test(record.id) ? record.id.trim() : "";
    validProfiles.push({ ...profile, ...(id ? { id } : {}) });
  });

  return { validProfiles, issues, skippedCount };
}

export type ImportedProfile = Omit<ConnectionProfile, "id"> & { id?: string };
export interface ConnectionImportPlan {
  original: ConnectionProfile[];
  next: ConnectionProfile[];
  changes: { kind: "added" | "overwritten"; profile: ConnectionProfile }[];
  addedCount: number;
  overwrittenCount: number;
  conflicts: string[];
}

function targetKey(profile: ImportedProfile): string {
  return isRelayProfile(profile) ? JSON.stringify(["relay", profile.deviceId])
    : JSON.stringify([profile.protocol, profile.hostname.toLowerCase(), profile.port, profile.username.trim()]);
}

/** Last entry wins per local identity; original endpoint aliases remain valid
 * even when an earlier row has changed that identity's endpoint. */
export function planProfileImport(existing: readonly ConnectionProfile[], imported: readonly ImportedProfile[]): ConnectionImportPlan {
  const original = existing.map(profile => ({
    id: profile.id, name: profile.name, protocol: profile.protocol, hostname: profile.hostname,
    username: profile.username, port: profile.port, environment: profile.environment,
    group: profile.group, tags: [...profile.tags], favorite: profile.favorite,
    ...(profile.deviceId !== undefined ? { deviceId: profile.deviceId } : {}),
    ...(profile.relayAddress !== undefined ? { relayAddress: profile.relayAddress } : {}),
    ...(profile.machineId !== undefined ? { machineId: profile.machineId } : {}),
    ...(profile.jumpProfileId !== undefined ? { jumpProfileId: profile.jumpProfileId } : {}),
    ...(profile.retiredTo !== undefined ? { retiredTo: profile.retiredTo } : {}),
  }));
  const next = [...original];
  const local = new Map(original.map((profile, index) => [profile.id, index]));
  const originalTargets = new Map<string, number>();
  original.forEach((profile, index) => { if (!originalTargets.has(targetKey(profile))) originalTargets.set(targetKey(profile), index); });
  const aliases = new Map<string, number>();
  const changed = new Set<number>();
  for (const source of imported) {
    const clean = createConnectionProfile(source, "");
    const key = targetKey(clean);
    const byId = source.id ? local.get(source.id) ?? aliases.get(source.id) : undefined;
    const index = byId ?? originalTargets.get(key) ?? next.findIndex(profile => targetKey(profile) === key);
    if (index >= 0) {
      next[index] = createConnectionProfile(clean, next[index].id);
      changed.add(index);
      if (source.id) aliases.set(source.id, index);
    } else {
      const profile = createConnectionProfile(clean);
      next.push(profile); changed.add(next.length - 1);
      if (source.id) aliases.set(source.id, next.length - 1);
    }
  }
  // References in a foreign export follow the newly allocated local IDs.
  for (const index of changed) {
    for (const field of ["jumpProfileId", "retiredTo"] as const) {
      const reference = next[index][field];
      const mapped = reference ? local.get(reference) ?? aliases.get(reference) : undefined;
      if (mapped !== undefined) next[index] = { ...next[index], [field]: next[mapped].id };
    }
  }
  // Id priority may deliberately change an endpoint. If that would create a
  // collision with another local identity, ask for correction instead of
  // silently deleting that identity (and its credential bindings).
  const originalKeys = new Map(original.map(profile => [profile.id, targetKey(profile)]));
  const groups = new Map<string, ConnectionProfile[]>();
  for (const profile of next) groups.set(targetKey(profile), [...groups.get(targetKey(profile)) ?? [], profile]);
  const conflicts = [...groups.entries()].flatMap(([key, profiles]) => profiles.length > 1
    && profiles.some(profile => originalKeys.get(profile.id) !== key)
    ? profiles.map(profile => profile.name) : []);
  const changes = [...changed].map(index => ({ kind: index < original.length ? "overwritten" as const : "added" as const, profile: next[index] }));
  return { original, next, changes, addedCount: changes.filter(change => change.kind === "added").length,
    overwrittenCount: changes.filter(change => change.kind === "overwritten").length, conflicts };
}

export function importPlanMatches(plan: ConnectionImportPlan, profiles: ConnectionProfile[]): boolean {
  return serializeProfiles(plan.original, "") === serializeProfiles(profiles, "");
}
