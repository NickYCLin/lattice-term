import { describe, expect, it } from "vitest";
import {
  formatDeviceId,
  inferRelayAddress,
  loadRelayAddress,
  normalizeDeviceId,
  saveRelayAddress,
} from "./remoteRelay";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

describe("device IDs", () => {
  it("accepts spaced and dashed nine-digit input", () => {
    expect(normalizeDeviceId("123 456 789")).toBe("123456789");
    expect(normalizeDeviceId("123-456-789")).toBe("123456789");
    expect(normalizeDeviceId("123456789")).toBe("123456789");
  });

  it("rejects anything that is not exactly nine digits", () => {
    expect(normalizeDeviceId("12345678")).toBeNull();
    expect(normalizeDeviceId("1234567890")).toBeNull();
    expect(normalizeDeviceId("12345678a")).toBeNull();
    expect(normalizeDeviceId("")).toBeNull();
  });

  it("formats in groups of three for reading aloud", () => {
    expect(formatDeviceId("123456789")).toBe("123 456 789");
    expect(formatDeviceId("123 456 789")).toBe("123 456 789");
    // Partial input stays untouched while the user is still typing.
    expect(formatDeviceId("1234")).toBe("1234");
  });
});

describe("remembered relay address", () => {
  it("round-trips through storage and trims input", () => {
    const storage = memoryStorage();
    saveRelayAddress(storage, "  relay.example.com:44910  ");
    expect(loadRelayAddress(storage)).toBe("relay.example.com:44910");
  });

  it("clears the entry when saved empty", () => {
    const storage = memoryStorage();
    saveRelayAddress(storage, "relay.example.com");
    saveRelayAddress(storage, "   ");
    expect(loadRelayAddress(storage)).toBe("");
  });
});

describe("inferRelayAddress", () => {
  it("prefers the install-wide remembered address", () => {
    const storage = memoryStorage();
    saveRelayAddress(storage, "wss://remembered.example/relay");
    expect(
      inferRelayAddress(storage, [{ relayAddress: "wss://profile.example/relay" }]),
    ).toBe("wss://remembered.example/relay");
  });

  it("falls back to a saved connection's relay when nothing is remembered", () => {
    const storage = memoryStorage();
    expect(
      inferRelayAddress(storage, [
        { relayAddress: "  " },
        { relayAddress: "wss://profile.example/relay" },
      ]),
    ).toBe("wss://profile.example/relay");
  });

  it("returns empty when no relay has been used or saved", () => {
    expect(inferRelayAddress(memoryStorage(), [{ relayAddress: "" }])).toBe("");
  });
});
