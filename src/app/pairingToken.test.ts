import { describe, expect, it } from "vitest";
import { normalizePairingToken, normalizePairingPassword, normalizeViewerPairingToken } from "./pairingToken";

describe("pairing tokens", () => {
  it("accepts legacy viewer codes only for device-ID connections", () => {
    expect(normalizeViewerPairingToken(" 1234-5678 ", true, true)).toBe("12345678");
    expect(normalizeViewerPairingToken("12345678", false, true)).toBeNull();
    expect(normalizePairingToken("12345678")).toBeNull();
    for (const input of ["1234abcd", "１２３４５６７８", "1234567", "123456789", "12345678\u200b"]) {
      expect(normalizeViewerPairingToken(input, true, true)).toBeNull();
    }
    for (const relay of [true, false]) {
      expect(normalizeViewerPairingToken("abcd".repeat(8), relay)).toBe("abcd".repeat(8));
    }
  });
  it("preserves case and all printable ASCII symbols in fixed passwords", () => {
    const passwords = ["123456", "1234567", "12345678", "aB3!xY", "aB-3!x", "aB'\"`$\\x", "aBcD".repeat(8), "!".repeat(64)];
    for (const password of passwords) {
      expect(normalizePairingPassword(password)).toBe(password);
      expect(normalizeViewerPairingToken(password, false)).toBe(password);
      expect(normalizeViewerPairingToken(password, true)).toBe(password);
    }
    expect(normalizePairingPassword("Ab3!xY")).not.toBe(normalizePairingPassword("ab3!xy"));
    for (const input of ["12345", "!".repeat(65), "aB 3!xy", " aB3!xy", "aB3!xy\n", "aB3!xy\u200b", "密碼123456", "aB3!xy\0"]) {
      expect(normalizePairingPassword(input)).toBeNull();
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
