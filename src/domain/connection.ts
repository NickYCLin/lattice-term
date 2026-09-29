/**
 * Connection metadata model.
 *
 * This module deliberately has no field for a password, passphrase, private
 * key or token. Secrets belong to the OS credential store; keeping this shape
 * secret-free means an entry can be logged,
 * exported or shown in a screenshot without leaking anything.
 *
 * Nothing here holds display text. Validation reports message keys and their
 * parameters, and the interface decides what language to render them in.
 */

import { formatDeviceId, normalizeDeviceId } from "../app/remoteRelay";
import type { MessageKey } from "../i18n/messages/zh-TW";

export const protocolCatalog = [
  {
    id: "ssh",
    /** Protocol acronyms stay untranslated; the description is localised. */
    acronym: "SSH",
    defaultPort: 22,
    milestone: 1,
    available: true,
  },
  {
    id: "sftp",
    acronym: "SFTP",
    defaultPort: 22,
    milestone: 3,
    available: true,
  },
  {
    id: "rdp",
    acronym: "RDP",
    defaultPort: 3389,
    milestone: 4,
    available: true,
  },
  {
    id: "vnc",
    acronym: "VNC",
    defaultPort: 5900,
    milestone: 5,
    available: true,
  },
  {
    id: "lattice",
    acronym: "REMOTE",
    defaultPort: 44900,
    milestone: 2,
    available: true,
  },
] as const;

export type Protocol = (typeof protocolCatalog)[number]["id"];

export type ProtocolDefinition = (typeof protocolCatalog)[number];

export const environmentCatalog = [
  "production",
  "staging",
  "development",
  "unassigned",
] as const;

export type Environment = (typeof environmentCatalog)[number];

export const UNGROUPED = "Ungrouped";

export const limits = {
  nameLength: 60,
  hostnameLength: 253,
  usernameLength: 64,
  groupLength: 40,
  tagLength: 24,
  tagCount: 6,
  minPort: 1,
  maxPort: 65535,
} as const;

export interface ConnectionDraft {
  name: string;
  protocol: Protocol;
  hostname: string;
  username: string;
  port: number;
  /** Optional organisation metadata; omitted drafts fall back to defaults. */
  environment?: Environment;
  group?: string;
  tags?: string[];
  favorite?: boolean;
  /** Set on relay entries; see `ConnectionProfile`. */
  deviceId?: string;
  relayAddress?: string;
  /** See `ConnectionProfile.machineId`. */
  machineId?: string;
}

export interface ConnectionProfile {
  id: string;
  name: string;
  protocol: Protocol;
  hostname: string;
  username: string;
  port: number;
  environment: Environment;
  group: string;
  tags: string[];
  favorite: boolean;
  /**
   * A Lattice Remote device reached through a relay rather than an address.
   * The relay finds the machine by this nine-digit identity, so `hostname`
   * and `port` are unused and stay empty on these entries.
   *
   * The pairing code is deliberately absent from metadata. Users may opt to
   * keep a permanent relay device's code in the secure credential backend,
   * but it never belongs in a stored profile.
   */
  deviceId?: string;
  /** The relay that resolves `deviceId`, as `wss://host` or `host:port`. */
  relayAddress?: string;
  /**
   * Entries that reach the same computer by different routes, for example
   * SSH and Lattice Remote, share this value and are shown as one card.
   */
  machineId?: string;
}

/** Whether an entry is addressed by device ID instead of hostname and port. */
export function isRelayProfile(
  entry: Pick<ConnectionProfile, "protocol" | "deviceId">,
): boolean {
  return entry.protocol === "lattice" && !!entry.deviceId;
}

/** A validation failure, expressed as something the interface can translate. */
export interface ValidationIssue {
  key: MessageKey;
  values?: Record<string, string | number>;
}

export type ValidationField =
  | "name"
  | "hostname"
  | "username"
  | "port"
  | "group"
  | "tags";

export type ValidationErrors = Partial<Record<ValidationField, ValidationIssue>>;

export function findProtocol(protocol: Protocol): ProtocolDefinition {
  return protocolCatalog.find((entry) => entry.id === protocol)!;
}

export function isProtocolAvailable(protocol: Protocol): boolean {
  return findProtocol(protocol).available;
}

export function protocolLabelKey(protocol: Protocol): MessageKey {
  return `protocol.${protocol}` as MessageKey;
}

export function protocolSummaryKey(protocol: Protocol): MessageKey {
  return `protocol.${protocol}.summary` as MessageKey;
}

/** Protocols whose remote login identifies a user account. */
export function protocolUsesUsername(protocol: Protocol): boolean {
  return protocol === "ssh" || protocol === "sftp" || protocol === "rdp";
}

export function environmentLabelKey(environment: Environment): MessageKey {
  return `environment.${environment}` as MessageKey;
}

export function environmentHintKey(environment: Environment): MessageKey {
  return `environment.${environment}.hint` as MessageKey;
}

export function emptyDraft(protocol: Protocol = "ssh"): ConnectionDraft {
  return {
    name: "",
    protocol,
    hostname: "",
    username: "",
    port: findProtocol(protocol).defaultPort,
    environment: "unassigned",
    group: "",
    tags: [],
    favorite: false,
  };
}

export function draftFromProfile(profile: ConnectionProfile): ConnectionDraft {
  return {
    name: profile.name,
    protocol: profile.protocol,
    hostname: profile.hostname,
    username: profile.username,
    port: profile.port,
    environment: profile.environment,
    group: profile.group === UNGROUPED ? "" : profile.group,
    tags: [...profile.tags],
    favorite: profile.favorite,
    // Carried through editing untouched: the form offers no way to retype a
    // device identity, and dropping it would turn a relay entry into a
    // direct one pointing at an empty address.
    ...(profile.deviceId ? { deviceId: profile.deviceId } : {}),
    ...(profile.relayAddress ? { relayAddress: profile.relayAddress } : {}),
    ...(profile.machineId ? { machineId: profile.machineId } : {}),
  };
}

/** Splits a free-text tag field into normalised, de-duplicated tags. */
export function parseTags(input: string | string[]): string[] {
  const parts = Array.isArray(input) ? input : input.split(/[,\n]/);
  const seen = new Set<string>();

  for (const part of parts) {
    const tag = part.trim().replace(/\s+/g, "-").toLowerCase();
    if (tag) seen.add(tag);
  }

  return [...seen];
}

/**
 * A hostname or IP literal. Kept intentionally permissive about the exact
 * label rules the resolver applies, while rejecting the shapes that would
 * silently break a command line: whitespace, schemes and embedded paths.
 */
const hostPattern = /^[A-Za-z0-9._:\-[\]%]+$/;

export function validateConnectionDraft(
  draft: ConnectionDraft,
): ValidationErrors {
  const errors: ValidationErrors = {};
  const name = draft.name.trim();
  const hostname = draft.hostname.trim();
  const username = draft.username.trim();
  const group = (draft.group ?? "").trim();
  const tags = parseTags(draft.tags ?? []);
  // A relay entry is addressed by device ID, so the address and port rules
  // below would reject a perfectly valid one for leaving them empty.
  const relay = isRelayProfile(draft);

  if (!name) {
    errors.name = { key: "validation.nameRequired" };
  } else if (name.length > limits.nameLength) {
    errors.name = {
      key: "validation.nameTooLong",
      values: { max: limits.nameLength },
    };
  }

  if (relay) {
    if (!normalizeDeviceId(draft.deviceId ?? "")) {
      errors.hostname = { key: "validation.deviceIdInvalid" };
    } else if (!(draft.relayAddress ?? "").trim()) {
      errors.hostname = { key: "validation.relayRequired" };
    }
  } else if (!hostname) {
    errors.hostname = { key: "validation.hostRequired" };
  } else if (/\s/.test(hostname)) {
    errors.hostname = { key: "validation.hostSpaces" };
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(hostname)) {
    errors.hostname = { key: "validation.hostScheme" };
  } else if (hostname.includes("/")) {
    errors.hostname = { key: "validation.hostPath" };
  } else if (hostname.includes("@")) {
    errors.hostname = { key: "validation.hostAccount" };
  } else if (!hostPattern.test(hostname)) {
    errors.hostname = { key: "validation.hostChars" };
  } else if (hostname.length > limits.hostnameLength) {
    errors.hostname = {
      key: "validation.hostTooLong",
      values: { max: limits.hostnameLength },
    };
  }

  if (protocolUsesUsername(draft.protocol) && !username) {
    errors.username = { key: "validation.usernameRequired" };
  } else if (/\s/.test(username)) {
    errors.username = { key: "validation.usernameSpaces" };
  } else if (username.length > limits.usernameLength) {
    errors.username = {
      key: "validation.usernameTooLong",
      values: { max: limits.usernameLength },
    };
  }

  if (relay) {
    // No port to check: the relay carries the session.
  } else if (!Number.isInteger(draft.port)) {
    errors.port = { key: "validation.portInteger" };
  } else if (draft.port < limits.minPort || draft.port > limits.maxPort) {
    errors.port = {
      key: "validation.portRange",
      values: { min: limits.minPort, max: limits.maxPort },
    };
  }

  if (group.length > limits.groupLength) {
    errors.group = {
      key: "validation.groupTooLong",
      values: { max: limits.groupLength },
    };
  }

  if (tags.length > limits.tagCount) {
    errors.tags = {
      key: "validation.tagsTooMany",
      values: { max: limits.tagCount },
    };
  } else if (tags.some((tag) => tag.length > limits.tagLength)) {
    errors.tags = {
      key: "validation.tagTooLong",
      values: { max: limits.tagLength },
    };
  }

  return errors;
}

export function createConnectionProfile(
  draft: ConnectionDraft,
  id: string = crypto.randomUUID(),
): ConnectionProfile {
  const group = (draft.group ?? "").trim();
  const deviceId = normalizeDeviceId(draft.deviceId ?? "");
  const relay = draft.protocol === "lattice" && !!deviceId;
  const machineId = normalizeMachineId(draft.machineId);

  return {
    id,
    name: draft.name.trim(),
    protocol: draft.protocol,
    // A relay entry has no address of its own; storing a stale one would
    // leave something misleading in exports and in the card subtitle.
    hostname: relay ? "" : draft.hostname.trim(),
    // Lattice Remote authenticates with a pairing code and VNC authenticates
    // the shared display. Neither has a username that belongs in the profile.
    username: protocolUsesUsername(draft.protocol) ? draft.username.trim() : "",
    port: relay ? 0 : draft.port,
    environment: draft.environment ?? "unassigned",
    group: group || UNGROUPED,
    tags: parseTags(draft.tags ?? []),
    favorite: draft.favorite ?? false,
    ...(relay
      ? {
          deviceId: deviceId!,
          relayAddress: (draft.relayAddress ?? "").trim(),
        }
      : {}),
    ...(machineId ? { machineId } : {}),
  };
}

/** A link key is an opaque short token; anything else is dropped. */
function normalizeMachineId(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return /^[A-Za-z0-9-]{1,64}$/.test(trimmed) ? trimmed : undefined;
}

/** One card on the connections page: an entry plus its same-machine peers. */
export interface MachineCard {
  profile: ConnectionProfile;
  linked: ConnectionProfile[];
}

/**
 * Folds entries that share a `machineId` into the first of them, keeping the
 * incoming order. A link with only one visible member stays an ordinary card.
 */
export function mergeMachineCards(profiles: ConnectionProfile[]): MachineCard[] {
  const members = new Map<string, ConnectionProfile[]>();
  for (const profile of profiles) {
    if (!profile.machineId) continue;
    const list = members.get(profile.machineId) ?? [];
    list.push(profile);
    members.set(profile.machineId, list);
  }
  const cards: MachineCard[] = [];
  for (const profile of profiles) {
    const peers = profile.machineId ? members.get(profile.machineId) : undefined;
    if (!peers || peers.length < 2) {
      cards.push({ profile, linked: [] });
    } else if (peers[0].id === profile.id) {
      cards.push({ profile, linked: peers.slice(1) });
    }
  }
  return cards;
}

/**
 * What an operator recognises at a glance: `user@host:port` for a direct
 * entry, and the spoken nine-digit identity for a relay one, which has no
 * address to show.
 */
export function connectionTarget(profile: ConnectionProfile): string {
  if (isRelayProfile(profile)) return formatDeviceId(profile.deviceId!);
  const account = profile.username ? `${profile.username}@` : "";
  return `${account}${profile.hostname}:${profile.port}`;
}

/**
 * Two entries addressing the same service. Reported as a non-blocking notice
 * rather than a validation error: intentional duplicates are legitimate, for
 * example the same host reached through different jump hosts.
 */
export function findDuplicateTarget(
  profiles: ConnectionProfile[],
  candidate: ConnectionProfile,
): ConnectionProfile | undefined {
  // Relay entries all share an empty hostname and port zero, so comparing
  // those would report every one of them as a duplicate of every other.
  if (isRelayProfile(candidate)) {
    return profiles.find(
      (profile) =>
        profile.id !== candidate.id && profile.deviceId === candidate.deviceId,
    );
  }
  return profiles.find(
    (profile) =>
      profile.id !== candidate.id &&
      !isRelayProfile(profile) &&
      profile.protocol === candidate.protocol &&
      profile.hostname.toLowerCase() === candidate.hostname.toLowerCase() &&
      profile.port === candidate.port,
  );
}
