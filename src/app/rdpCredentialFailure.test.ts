import { expect, it } from "vitest";
import { rdpCredentialFailure } from "./rdpCredentialFailure";

it.each([
  ["[CredSSP] STATUS_PASSWORD_EXPIRED [0xc0000071]", "expired"],
  ["CredSSP: 0xC0000071", "expired"],
  ["STATUS_PASSWORD_MUST_CHANGE", "mustChange"],
  ["CredSSP: 0xc0000224", "mustChange"],
  ["STATUS_LOGON_FAILURE", "rejected"],
  ["CredSSP: 0xC000006A", "rejected"],
  ["TLS certificate validation failed", null],
  ["connection timeout", null],
  ["0xC000007100", null],
])("classifies %s without treating network errors as bad passwords", (detail, expected) => {
  expect(rdpCredentialFailure(detail)).toBe(expected);
});
