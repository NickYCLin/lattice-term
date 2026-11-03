import type { ConnectionProfile } from "./connection";
import type { DatabaseProfile } from "./database";
import { emptyFilter, type ConnectionFilter } from "./query";

export type ConnectionSetupMode = "remote" | "database" | "both";
export type ConnectionSetupSection = "remote" | "database";
export interface DatabaseWorkspaceTarget { profileId?: string; hostKeys?: string[] }

export function databaseRemoteHost(database: DatabaseProfile, profiles: ConnectionProfile[]) {
  return profiles.find(profile => profile.id === database.hostKey || profile.machineId === database.hostKey);
}

export function databasesForHost(databases: DatabaseProfile[], hostKeys: string[]) {
  return databases.filter(database => hostKeys.includes(database.hostKey));
}

export function databaseListEntries(databases: DatabaseProfile[], profiles: ConnectionProfile[],
  visibleProfiles: ConnectionProfile[], kind: "all" | "remote" | "database", filter: ConnectionFilter = emptyFilter) {
  if (kind === "remote") return [];
  const query = filter.search.trim().toLocaleLowerCase();
  const remoteFilter = filter.protocols.length || filter.environments.length || filter.tags.length || filter.favoritesOnly || filter.group !== null;
  return databases.filter(database => {
    const host = databaseRemoteHost(database, profiles);
    if (kind === "all" && !query && host) return false;
    if (remoteFilter && (!host || !visibleProfiles.some(profile => profile.id === database.hostKey || profile.machineId === database.hostKey))) return false;
    return !query || [database.name, database.engine, database.hostname, database.database, database.sqlitePath, host?.name ?? ""].join(" ").toLocaleLowerCase().includes(query);
  });
}
