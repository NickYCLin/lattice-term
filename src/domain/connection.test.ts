import { describe, expect, it } from "vitest";
import {
  UNGROUPED,
  connectionTarget,
  createConnectionProfile,
  draftFromProfile,
  emptyDraft,
  findDuplicateTarget,
  isProtocolAvailable,
  isRelayProfile,
  mergeMachineCards,
  parseTags,
  protocolUsesUsername,
  validateConnectionDraft,
} from "./connection";

describe("connection profiles", () => {
  it("normalizes profile metadata without accepting secret fields", () => {
    const profile = createConnectionProfile(
      {
        name: "  Production  ",
        protocol: "ssh",
        hostname: "  server.example.com ",
        username: " deploy ",
        port: 22,
        environment: "production",
        group: "  Core platform ",
        tags: [" Edge ", "edge", "eu west", ""],
        favorite: true,
      },
      "profile-1",
    );

    expect(profile).toEqual({
      id: "profile-1",
      name: "Production",
      protocol: "ssh",
      hostname: "server.example.com",
      username: "deploy",
      port: 22,
      environment: "production",
      group: "Core platform",
      tags: ["edge", "eu-west"],
      favorite: true,
    });
  });

  it("falls back to unassigned metadata when a draft omits it", () => {
    const profile = createConnectionProfile(
      {
        name: "Lab box",
        protocol: "vnc",
        hostname: "192.0.2.87",
        username: "",
        port: 5901,
      },
      "profile-2",
    );

    expect(profile.environment).toBe("unassigned");
    expect(profile.group).toBe(UNGROUPED);
    expect(profile.tags).toEqual([]);
    expect(profile.favorite).toBe(false);
  });

  it("starts a draft on the default port of the chosen protocol", () => {
    expect(emptyDraft("rdp").port).toBe(3389);
    expect(emptyDraft("lattice").port).toBe(44900);
    expect(emptyDraft().protocol).toBe("ssh");
  });

  it("retains usernames only for account-based protocols", () => {
    const profile = createConnectionProfile(
      {
        name: "Remote screen",
        protocol: "lattice",
        hostname: "192.0.2.42",
        username: "operator-from-an-older-draft",
        port: 44900,
      },
      "profile-remote",
    );

    expect(profile.username).toBe("");
    expect(connectionTarget(profile)).toBe("192.0.2.42:44900");

    const vnc = createConnectionProfile(
      {
        name: "Shared screen",
        protocol: "vnc",
        hostname: "192.0.2.87",
        username: "stale-account",
        port: 5900,
      },
      "profile-vnc",
    );
    expect(vnc.username).toBe("");
    expect(protocolUsesUsername("ssh")).toBe(true);
    expect(protocolUsesUsername("sftp")).toBe(true);
    expect(protocolUsesUsername("rdp")).toBe(true);
    expect(protocolUsesUsername("vnc")).toBe(false);
    expect(protocolUsesUsername("lattice")).toBe(false);
  });

  it("reports only protocols with working session engines as available", () => {
    expect(isProtocolAvailable("ssh")).toBe(true);
    expect(isProtocolAvailable("rdp")).toBe(true);
    expect(isProtocolAvailable("lattice")).toBe(true);
    expect(isProtocolAvailable("sftp")).toBe(true);
    expect(isProtocolAvailable("vnc")).toBe(true);
  });

  it("round-trips a profile into an editable draft", () => {
    const profile = createConnectionProfile(
      {
        name: "Lab box",
        protocol: "vnc",
        hostname: "192.0.2.87",
        username: "",
        port: 5901,
      },
      "profile-3",
    );

    // Ungrouped is a display bucket, not a group the user typed.
    expect(draftFromProfile(profile).group).toBe("");
  });

  it("formats a target the way an operator reads it", () => {
    const withUser = createConnectionProfile(
      {
        name: "Edge",
        protocol: "ssh",
        hostname: "gateway.example.com",
        username: "operator",
        port: 2222,
      },
      "profile-4",
    );
    const withoutUser = createConnectionProfile(
      {
        name: "Lab",
        protocol: "vnc",
        hostname: "192.0.2.87",
        username: "",
        port: 5900,
      },
      "profile-5",
    );

    expect(connectionTarget(withUser)).toBe(
      "operator@gateway.example.com:2222",
    );
    expect(connectionTarget(withoutUser)).toBe("192.0.2.87:5900");
  });
});

describe("tag parsing", () => {
  it("splits, normalizes and de-duplicates tag input", () => {
    expect(parseTags("Edge, edge\nEU West ,, ")).toEqual(["edge", "eu-west"]);
  });
});

describe("draft validation", () => {
  it("rejects missing metadata, whitespace in hosts, and invalid ports", () => {
    expect(
      validateConnectionDraft({
        name: "",
        protocol: "rdp",
        hostname: "not a host",
        username: "",
        port: 70000,
      }),
    ).toEqual({
      name: { key: "validation.nameRequired" },
      hostname: { key: "validation.hostSpaces" },
      username: { key: "validation.usernameRequired" },
      port: {
        key: "validation.portRange",
        values: { min: 1, max: 65535 },
      },
    });
  });

  it("explains host input that belongs in another field", () => {
    const scheme = validateConnectionDraft({
      ...emptyDraft(),
      name: "Edge",
      hostname: "ssh://gateway.example.com",
    });
    const account = validateConnectionDraft({
      ...emptyDraft(),
      name: "Edge",
      hostname: "operator@gateway.example.com",
    });
    const path = validateConnectionDraft({
      ...emptyDraft(),
      name: "Edge",
      hostname: "gateway.example.com/admin",
    });

    expect(scheme.hostname).toEqual({ key: "validation.hostScheme" });
    expect(account.hostname).toEqual({ key: "validation.hostAccount" });
    expect(path.hostname).toEqual({ key: "validation.hostPath" });
  });

  it("accepts IPv6 literals and rejects unusable characters", () => {
    expect(
      validateConnectionDraft({
        ...emptyDraft(),
        name: "Edge",
        hostname: "[2001:db8::1]",
      }).hostname,
    ).toBeUndefined();

    expect(
      validateConnectionDraft({
        ...emptyDraft(),
        name: "Edge",
        hostname: "gateway,example.com",
      }).hostname,
    ).toEqual({ key: "validation.hostChars" });
  });

  it("limits organisation metadata so rows stay readable", () => {
    const errors = validateConnectionDraft({
      ...emptyDraft(),
      name: "Edge",
      hostname: "gateway.example.com",
      username: "an operator",
      tags: ["a", "b", "c", "d", "e", "f", "g"],
    });

    expect(errors.username).toEqual({ key: "validation.usernameSpaces" });
    expect(errors.tags).toEqual({
      key: "validation.tagsTooMany",
      values: { max: 6 },
    });
  });

  it("accepts a complete draft", () => {
    expect(
      validateConnectionDraft({
        name: "Edge gateway",
        protocol: "ssh",
        hostname: "gateway.example.com",
        username: "operator",
        port: 22,
        environment: "production",
        group: "Core platform",
        tags: ["edge"],
      }),
    ).toEqual({});
  });

  it("requires usernames only for account-based protocols", () => {
    for (const protocol of ["ssh", "sftp", "rdp"] as const) {
      expect(
        validateConnectionDraft({
          ...emptyDraft(protocol),
          name: "Remote host",
          hostname: "host.example.com",
        }).username,
      ).toEqual({ key: "validation.usernameRequired" });
    }

    for (const protocol of ["vnc", "lattice"] as const) {
      expect(
        validateConnectionDraft({
          ...emptyDraft(protocol),
          name: "Remote host",
          hostname: "host.example.com",
        }).username,
      ).toBeUndefined();
    }
  });
});

describe("duplicate targets", () => {
  const base = createConnectionProfile(
    {
      name: "Edge gateway",
      protocol: "ssh",
      hostname: "gateway.example.com",
      username: "operator",
      port: 22,
    },
    "profile-a",
  );

  it("reports another profile that addresses the same service", () => {
    const candidate = createConnectionProfile(
      {
        name: "Edge gateway copy",
        protocol: "ssh",
        hostname: "GATEWAY.example.com",
        username: "root",
        port: 22,
      },
      "profile-b",
    );

    expect(findDuplicateTarget([base], candidate)?.id).toBe("profile-a");
  });

  it("ignores itself, other protocols and other ports", () => {
    expect(findDuplicateTarget([base], base)).toBeUndefined();
    expect(
      findDuplicateTarget([base], {
        ...base,
        id: "profile-c",
        protocol: "sftp",
      }),
    ).toBeUndefined();
    expect(
      findDuplicateTarget([base], { ...base, id: "profile-d", port: 2222 }),
    ).toBeUndefined();
  });
});

describe("relay entries", () => {
  const draft = {
    name: "Workshop",
    protocol: "lattice" as const,
    hostname: "",
    username: "",
    port: 0,
    deviceId: "018536454",
    relayAddress: "wss://relay.example.com",
  };

  it("stores a device identity instead of an address", () => {
    const profile = createConnectionProfile(draft, "relay-a");

    expect(isRelayProfile(profile)).toBe(true);
    expect(profile.deviceId).toBe("018536454");
    expect(profile.relayAddress).toBe("wss://relay.example.com");
    expect(profile.hostname).toBe("");
    expect(profile.port).toBe(0);
  });

  it("never carries a pairing code in connection metadata", () => {
    const profile = createConnectionProfile(
      { ...draft, pairingCode: "12345678" } as never,
      "relay-a",
    );

    expect(JSON.stringify(profile)).not.toContain("12345678");
  });

  it("accepts an empty address and port that a direct entry may not", () => {
    expect(validateConnectionDraft(draft)).toEqual({});
  });

  it("still insists on a readable identity and a relay to reach it", () => {
    expect(validateConnectionDraft({ ...draft, deviceId: "12345" }).hostname)
      .toEqual({ key: "validation.deviceIdInvalid" });
    expect(validateConnectionDraft({ ...draft, relayAddress: "  " }).hostname)
      .toEqual({ key: "validation.relayRequired" });
  });

  it("reads the identity in the grouping people speak it in", () => {
    expect(connectionTarget(createConnectionProfile(draft, "relay-a"))).toBe(
      "018 536 454",
    );
  });

  it("survives editing without losing the identity", () => {
    const profile = createConnectionProfile(draft, "relay-a");
    const renamed = createConnectionProfile(
      { ...draftFromProfile(profile), name: "Studio" },
      profile.id,
    );

    expect(renamed.name).toBe("Studio");
    expect(renamed.deviceId).toBe("018536454");
    expect(renamed.relayAddress).toBe("wss://relay.example.com");
  });

  it("matches duplicates by identity, not by the empty address they share", () => {
    const saved = createConnectionProfile(draft, "relay-a");
    const sameDevice = createConnectionProfile(draft, "relay-b");
    const otherDevice = createConnectionProfile(
      { ...draft, deviceId: "309759966" },
      "relay-c",
    );

    expect(findDuplicateTarget([saved], sameDevice)?.id).toBe("relay-a");
    expect(findDuplicateTarget([saved], otherDevice)).toBeUndefined();
  });

  it("is never confused with a direct entry of the same protocol", () => {
    const direct = createConnectionProfile(
      {
        name: "Lab box",
        protocol: "lattice",
        hostname: "10.0.0.5",
        username: "",
        port: 44900,
      },
      "direct-a",
    );
    const relay = createConnectionProfile(draft, "relay-a");

    expect(isRelayProfile(direct)).toBe(false);
    expect(findDuplicateTarget([direct], relay)).toBeUndefined();
    expect(findDuplicateTarget([relay], direct)).toBeUndefined();
  });
});

describe("same-computer links", () => {
  const ssh = createConnectionProfile(
    { ...emptyDraft("ssh"), name: "mac", hostname: "192.168.10.201", username: "me", machineId: "m1" },
    "ssh",
  );
  const remote = createConnectionProfile(
    { ...emptyDraft("lattice"), name: "蘋果筆電", deviceId: "008806370", machineId: "m1" },
    "remote",
  );
  const other = createConnectionProfile(
    { ...emptyDraft("ssh"), name: "nas", hostname: "nas.local", username: "me" },
    "other",
  );

  it("folds linked entries into the first one and keeps the order", () => {
    expect(mergeMachineCards([other, remote, ssh])).toEqual([
      { profile: other, linked: [] },
      { profile: remote, linked: [ssh] },
    ]);
  });

  it("shows a link with a single visible member as a plain card", () => {
    expect(mergeMachineCards([ssh, other])).toEqual([
      { profile: ssh, linked: [] },
      { profile: other, linked: [] },
    ]);
  });

  it("survives editing and drops a malformed key", () => {
    expect(createConnectionProfile(draftFromProfile(ssh), "ssh").machineId).toBe("m1");
    const bad = createConnectionProfile(
      { ...draftFromProfile(ssh), machineId: "../../etc" },
      "ssh",
    );
    expect(bad).not.toHaveProperty("machineId");
  });
});
