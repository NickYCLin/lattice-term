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
  profiles: ConnectionDraft[];
}

export interface ImportIssue {
  key: MessageKey;
  values?: Record<string, string | number>;
  /** Field-level reasons, rendered into the entry's message by the caller. */
  fieldIssues?: ValidationIssue[];
}

export interface ImportResult {
  validProfiles: ConnectionProfile[];
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
  const validProfiles: ConnectionProfile[] = [];
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

    validProfiles.push(createConnectionProfile(draft));
  });

  return { validProfiles, issues, skippedCount };
}
