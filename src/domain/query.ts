/**
 * Search, filter and grouping rules for the connection list.
 *
 * Kept out of the components so the behaviour operators depend on most —
 * "type three characters, find the host" — is unit tested.
 */

import {
  UNGROUPED,
  connectionTarget,
  tagKey,
  uniqueTags,
  type ConnectionProfile,
  type Environment,
  type Protocol,
} from "./connection";

export interface ConnectionFilter {
  search: string;
  protocols: Protocol[];
  environments: Environment[];
  tags: string[];
  favoritesOnly: boolean;
  group: string | null;
}

export const emptyFilter: ConnectionFilter = {
  search: "",
  protocols: [],
  environments: [],
  tags: [],
  favoritesOnly: false,
  group: null,
};

export function isFilterActive(filter: ConnectionFilter): boolean {
  return (
    filter.search.trim() !== "" ||
    filter.protocols.length > 0 ||
    filter.environments.length > 0 ||
    filter.tags.length > 0 ||
    filter.favoritesOnly ||
    filter.group !== null
  );
}

/** Matches on every field the row displays, so nothing looks like a miss. */
export function matchesSearch(
  profile: ConnectionProfile,
  search: string,
): boolean {
  const term = search.trim().toLowerCase();
  if (!term) return true;

  const haystack = [
    profile.name,
    profile.hostname,
    profile.username,
    profile.protocol,
    profile.environment,
    profile.group,
    connectionTarget(profile),
    ...profile.tags,
  ]
    .join(" ")
    .toLowerCase();

  return term.split(/\s+/).every((token) => haystack.includes(token));
}

export function filterProfiles(
  profiles: ConnectionProfile[],
  filter: ConnectionFilter,
): ConnectionProfile[] {
  const selectedTagKeys = filter.tags.map(tagKey);
  return profiles.filter((profile) => {
    if (filter.favoritesOnly && !profile.favorite) return false;
    if (filter.group !== null && profile.group !== filter.group) return false;
    if (
      filter.protocols.length > 0 &&
      !filter.protocols.includes(profile.protocol)
    ) {
      return false;
    }
    if (
      filter.environments.length > 0 &&
      !filter.environments.includes(profile.environment)
    ) {
      return false;
    }
    if (selectedTagKeys.length > 0) {
      const profileTagKeys = new Set(profile.tags.map(tagKey));
      if (!selectedTagKeys.every((key) => profileTagKeys.has(key))) return false;
    }
    return matchesSearch(profile, filter.search);
  });
}

export type SortOrder = "name" | "hostname" | "environment";

const environmentRank: Record<Environment, number> = {
  production: 0,
  staging: 1,
  development: 2,
  unassigned: 3,
};

const compareByName = (a: ConnectionProfile, b: ConnectionProfile) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

/** Favorites lead every order: they are the three-click path to a session. */
export function sortProfiles(
  profiles: ConnectionProfile[],
  order: SortOrder,
): ConnectionProfile[] {
  return [...profiles].sort((a, b) => {
    if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;

    if (order === "hostname") {
      const byHost = a.hostname.localeCompare(b.hostname, undefined, {
        sensitivity: "base",
      });
      if (byHost !== 0) return byHost;
    }

    if (order === "environment") {
      const byEnvironment =
        environmentRank[a.environment] - environmentRank[b.environment];
      if (byEnvironment !== 0) return byEnvironment;
    }

    return compareByName(a, b);
  });
}

export interface ConnectionGroup {
  name: string;
  profiles: ConnectionProfile[];
}

/** Groups in alphabetical order, with `Ungrouped` pinned last. */
export function groupProfiles(
  profiles: ConnectionProfile[],
): ConnectionGroup[] {
  const groups = new Map<string, ConnectionProfile[]>();

  for (const profile of profiles) {
    const bucket = groups.get(profile.group);
    if (bucket) bucket.push(profile);
    else groups.set(profile.group, [profile]);
  }

  return [...groups.entries()]
    .map(([name, entries]) => ({ name, profiles: entries }))
    .sort((a, b) => {
      if (a.name === UNGROUPED) return 1;
      if (b.name === UNGROUPED) return -1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
}

export function collectTags(profiles: ConnectionProfile[]): string[] {
  return uniqueTags(profiles.flatMap((profile) => profile.tags))
    .sort((a, b) => tagKey(a).localeCompare(tagKey(b)));
}
