import { describe, expect, it } from "vitest";
import { normalizePairingToken, normalizeViewerPairingToken } from "./pairingToken";

describe("pairing tokens", () => {
  it("accepts legacy viewer codes only for device-ID connections", () => {
    expect(normalizeViewerPairingToken(" 1234-5678 ", true)).toBe("12345678");
    expect(normalizeViewerPairingToken("12345678", false)).toBeNull();
    expect(normalizePairingToken("12345678")).toBeNull();
    for (const input of ["1234abcd", "１２３４５６７８", "1234567", "123456789", "12345678\u200b"]) {
      expect(normalizeViewerPairingToken(input, true)).toBeNull();
    }
    for (const relay of [true, false]) {
      expect(normalizeViewerPairingToken("abcd".repeat(8), relay)).toBe("ABCD".repeat(8));
    }
  });
  it("accepts the complete generated token with readable separators", () => {
    expect(normalizePairingToken(" 0123-4567-89ab-cdef-0123-4567-89ab-cdef "))
      .toBe("0123456789ABCDEF0123456789ABCDEF");
  });
  it("rejects short codes, hidden characters and truncated or extra input", () => {
    for (const input of ["1234-5678", "A".repeat(31), "A".repeat(33), "G".repeat(32), `${"A".repeat(32)}\u200b`]) {
      expect(normalizePairingToken(input)).toBeNull();
    }
  });
});
