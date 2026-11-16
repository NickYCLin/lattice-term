import { expect, it } from "vitest";
import { nativeReadError } from "./nativeReadDiagnostics";
import type { I18nValue } from "../i18n/context";
const t: I18nValue["t"] = (key, values) => `${key} ${JSON.stringify(values ?? {})}`;
it("never prints original full paths or secret-shaped fields from a native read failure", () => {
  const error = nativeReadError(`native.read:${JSON.stringify({ cli: "Codex", file: "C:\\synthetic\\rollout.jsonl", reason: "decode", token: "sk-test-not-real" })}`, t);
  expect(error).toContain("rollout.jsonl"); expect(error).toContain("history.reason.decode");
  expect(error).not.toMatch(/synthetic|sk-test-not-real/);
});
it("bounds and masks unknown legacy read errors", () => {
  const error = nativeReadError("Cannot open /synthetic/private/session.jsonl password=synthetic-value", t);
  expect(error).not.toContain("/synthetic"); expect(error).not.toContain("synthetic-value");
});
