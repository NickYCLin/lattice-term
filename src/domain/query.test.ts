import { describe, expect, it } from "vitest";
import { UNGROUPED, type ConnectionProfile } from "./connection";
import {
  collectTags,
  emptyFilter,
  filterProfiles,
  groupProfiles,
  isFilterActive,
  matchesSearch,
  sortProfiles,
} from "./query";

function profile(overrides: Partial<ConnectionProfile>): ConnectionProfile {
  return {
    id: "id",
    name: "Host",
    protocol: "ssh",
    hostname: "host.example.com",
    username: "operator",
    port: 22,
    environment: "unassigned",
    group: UNGROUPED,
    tags: [],
    favorite: false,
    ...overrides,
  };
}

const gateway = profile({
  id: "gateway",
  name: "Edge gateway",
  hostname: "gateway.example.com",
  environment: "production",
  group: "Core platform",
  tags: ["edge", "eu-west"],
  favorite: true,
});

const builder = profile({
  id: "builder",
  name: "Build agent",
  protocol: "sftp",
  hostname: "192.0.2.41",
  username: "runner",
  port: 2222,
  environment: "development",
  group: "Build farm",
  tags: ["ci"],
});

const desktop = profile({
  id: "desktop",
  name: "Reporting desktop",
  protocol: "rdp",
  hostname: "desktop.example.org",
  port: 3389,
  environment: "staging",
});

const all = [gateway, builder, desktop];

describe("search", () => {
  it("matches every field the row shows", () => {
    expect(matchesSearch(gateway, "gateway")).toBe(true);
    expect(matchesSearch(gateway, "eu-west")).toBe(true);
    expect(matchesSearch(gateway, "production")).toBe(true);
    expect(matchesSearch(builder, "runner@192.0.2.41:2222")).toBe(true);
  });

  it("requires every token, in any order", () => {
    expect(matchesSearch(gateway, "edge core")).toBe(true);
    expect(matchesSearch(gateway, "edge build")).toBe(false);
  });

  it("treats blank input as a match", () => {
    expect(matchesSearch(desktop, "   ")).toBe(true);
  });
});

describe("filtering", () => {
  it("returns everything for the empty filter", () => {
    expect(filterProfiles(all, emptyFilter)).toHaveLength(3);
    expect(isFilterActive(emptyFilter)).toBe(false);
  });

  it("combines facets as an intersection", () => {
    expect(
      filterProfiles(all, {
        ...emptyFilter,
        protocols: ["ssh", "sftp"],
        environments: ["development"],
      }).map((entry) => entry.id),
    ).toEqual(["builder"]);
  });

  it("requires every selected tag", () => {
    expect(
      filterProfiles(all, { ...emptyFilter, tags: ["edge", "eu-west"] }),
    ).toHaveLength(1);
    expect(
      filterProfiles(all, { ...emptyFilter, tags: ["edge", "ci"] }),
    ).toHaveLength(0);
  });

  it("matches mixed-case and legacy lowercase tags with the same filter", () => {
    const mixed = profile({ id: "mixed", tags: ["Edge", "EU-West"] });
    expect(filterProfiles([...all, mixed], {
      ...emptyFilter,
      tags: ["EDGE", "eu-west"],
      search: "Eu-WeSt",
    })).toEqual([gateway, mixed]);
  });

  it("filters by favorites and by group", () => {
    expect(
      filterProfiles(all, { ...emptyFilter, favoritesOnly: true }).map(
        (entry) => entry.id,
      ),
    ).toEqual(["gateway"]);
    expect(
      filterProfiles(all, { ...emptyFilter, group: "Build farm" }).map(
        (entry) => entry.id,
      ),
    ).toEqual(["builder"]);
  });

  it("reports an active filter for any facet", () => {
    expect(isFilterActive({ ...emptyFilter, search: " " })).toBe(false);
    expect(isFilterActive({ ...emptyFilter, search: "edge" })).toBe(true);
    expect(isFilterActive({ ...emptyFilter, group: UNGROUPED })).toBe(true);
  });
});

describe("sorting", () => {
  it("keeps favorites first in every order", () => {
    expect(sortProfiles(all, "name")[0].id).toBe("gateway");
    expect(sortProfiles(all, "hostname")[0].id).toBe("gateway");
    expect(sortProfiles(all, "environment")[0].id).toBe("gateway");
  });

  it("orders non-favorites by the chosen key", () => {
    const plain = [builder, desktop];

    expect(sortProfiles(plain, "hostname").map((entry) => entry.id)).toEqual([
      "builder",
      "desktop",
    ]);
    expect(sortProfiles(plain, "environment").map((entry) => entry.id)).toEqual([
      "desktop",
      "builder",
    ]);
    expect(sortProfiles(plain, "name").map((entry) => entry.id)).toEqual([
      "builder",
      "desktop",
    ]);
  });

  it("does not mutate the input", () => {
    const input = [desktop, gateway];
    sortProfiles(input, "name");
    expect(input.map((entry) => entry.id)).toEqual(["desktop", "gateway"]);
  });
});

describe("grouping", () => {
  it("sorts groups alphabetically and pins Ungrouped last", () => {
    expect(groupProfiles(all).map((group) => group.name)).toEqual([
      "Build farm",
      "Core platform",
      UNGROUPED,
    ]);
  });

  it("collects a sorted, de-duplicated tag list", () => {
    expect(collectTags(all)).toEqual(["ci", "edge", "eu-west"]);
    expect(collectTags([profile({ tags: ["Edge"] }), ...all])).toEqual(["ci", "Edge", "eu-west"]);
  });
});
