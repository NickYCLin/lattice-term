import { describe, expect, it } from "vitest";
import { createConnectionProfile } from "./connection";
import {
  parseAndValidateImport,
  serializeProfiles,
  type LatticeTermExport,
} from "./export";

describe("export & import", () => {
  const profile1 = createConnectionProfile(
    {
      name: "Gateway",
      protocol: "ssh",
      hostname: "gw.example.com",
      username: "admin",
      port: 22,
      environment: "production",
      group: "Infra",
      tags: ["edge", "eu"],
      favorite: true,
    },
    "p-1",
  );

  const profile2 = createConnectionProfile(
    {
      name: "Windows Desktop",
      protocol: "rdp",
      hostname: "rdp.example.com",
      username: "user",
      port: 3389,
      environment: "staging",
    },
    "p-2",
  );

  it("serializes profiles to json with metadata and version", () => {
    const json = serializeProfiles([profile1, profile2], "2026-08-20T00:00:00.000Z");
    const parsed = JSON.parse(json) as LatticeTermExport;

    expect(parsed.version).toBe(1);
    expect(parsed.application).toBe("LatticeTerm");
    expect(parsed.exportedAt).toBe("2026-08-20T00:00:00.000Z");
    expect(parsed.profiles).toHaveLength(2);
    expect(parsed.profiles[0].name).toBe("Gateway");
    expect(parsed.profiles[0].tags).toEqual(["edge", "eu"]);
  });

  it("keeps the same-computer link through export and import", () => {
    const linked = [
      { ...profile1, machineId: "m1" },
      { ...profile2, machineId: "m1" },
    ];
    const result = parseAndValidateImport(serializeProfiles(linked));

    expect(result.validProfiles.map((entry) => entry.machineId)).toEqual(["m1", "m1"]);
    expect(JSON.parse(serializeProfiles([profile1])).profiles[0]).not.toHaveProperty("machineId");
  });

  it("successfully parses and validates valid export JSON", () => {
    const json = serializeProfiles([profile1, profile2]);
    const result = parseAndValidateImport(json);

    expect(result.issues).toHaveLength(0);
    expect(result.skippedCount).toBe(0);
    expect(result.validProfiles).toHaveLength(2);
    expect(result.validProfiles[0].name).toBe("Gateway");
    expect(result.validProfiles[0].protocol).toBe("ssh");
    expect(result.validProfiles[1].name).toBe("Windows Desktop");
    expect(result.validProfiles[1].protocol).toBe("rdp");
  });

  it("handles raw array of profiles without envelope", () => {
    const rawArray = [
      {
        name: "Test SSH",
        protocol: "ssh",
        hostname: "test.example.com",
        username: "test",
        port: 22,
      },
    ];
    const result = parseAndValidateImport(JSON.stringify(rawArray));

    expect(result.issues).toHaveLength(0);
    expect(result.validProfiles).toHaveLength(1);
    expect(result.validProfiles[0].name).toBe("Test SSH");
  });

  it("rejects invalid JSON syntax", () => {
    const result = parseAndValidateImport("{ not valid json");
    expect(result.issues).toEqual([{ key: "transfer.error.json" }]);
    expect(result.validProfiles).toHaveLength(0);
  });

  it("skips invalid entries and reports why, as keys", () => {
    const invalidData = {
      version: 1,
      application: "LatticeTerm",
      profiles: [
        {
          name: "Good",
          protocol: "ssh",
          hostname: "valid.example.com",
          username: "admin",
          port: 22,
        },
        {
          name: "",
          protocol: "ssh",
          hostname: "no-name.example.com",
          username: "admin",
          port: 22,
        },
        {
          name: "Bad Host",
          protocol: "ssh",
          hostname: "spaces in host",
          username: "admin",
          port: 22,
        },
        {
          name: "Unknown Proto",
          protocol: "telnet",
          hostname: "valid.example.com",
          port: 23,
        },
      ],
    };

    const result = parseAndValidateImport(JSON.stringify(invalidData));
    expect(result.validProfiles).toHaveLength(1);
    expect(result.validProfiles[0].name).toBe("Good");
    expect(result.skippedCount).toBe(3);
    expect(result.issues.map((issue) => issue.key)).toEqual([
      "transfer.error.invalidEntry",
      "transfer.error.invalidEntry",
      "transfer.error.unknownProtocol",
    ]);

    // The reason travels as a key too, so an import explains itself in any
    // language rather than in whichever one produced the file.
    expect(result.issues[0].fieldIssues).toEqual([
      { key: "validation.nameRequired" },
    ]);
    expect(result.issues[1].fieldIssues).toEqual([
      { key: "validation.hostSpaces" },
    ]);
    expect(result.issues[2].values).toEqual({
      index: 4,
      name: "Unknown Proto",
      protocol: "telnet",
    });
  });
});

describe("relay entries in a transfer file", () => {
  it("survives an export and import round trip", () => {
    const device = createConnectionProfile(
      {
        name: "Workshop",
        protocol: "lattice",
        hostname: "",
        username: "",
        port: 0,
        deviceId: "018536454",
        relayAddress: "wss://relay.example.com",
      },
      "relay-a",
    );

    const result = parseAndValidateImport(serializeProfiles([device]));

    expect(result.issues).toEqual([]);
    expect(result.validProfiles).toHaveLength(1);
    const restored = result.validProfiles[0];
    expect(restored.deviceId).toBe("018536454");
    expect(restored.relayAddress).toBe("wss://relay.example.com");
    expect(restored.hostname).toBe("");
  });

  it("leaves direct entries without the relay fields", () => {
    const direct = createConnectionProfile({
      name: "Gateway",
      protocol: "ssh",
      hostname: "gw.example.com",
      username: "root",
      port: 22,
    });

    const written = JSON.parse(serializeProfiles([direct])) as {
      profiles: Record<string, unknown>[];
    };

    expect(written.profiles[0]).not.toHaveProperty("deviceId");
    expect(written.profiles[0]).not.toHaveProperty("relayAddress");
  });
});
