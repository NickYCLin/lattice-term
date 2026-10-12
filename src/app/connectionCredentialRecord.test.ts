import { expect, it, vi } from "vitest";
import { createConnectionProfile, emptyDraft } from "../domain/connection";
import { persistConnectionRecord, sameCredentialTarget, supportsCredentialRecord } from "./connectionCredentialRecord";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));

it("saves the profile and credential through a dedicated native command, without connecting", async () => {
  const profile = createConnectionProfile({ ...emptyDraft(), hostname: "offline.example" }, "profile");
  const credential = { secret: "test-only-password", allowMcpRead: false };
  await persistConnectionRecord(profile, credential);
  expect(native.invoke).toHaveBeenCalledExactlyOnceWith("save_connection_record", { profile, credential });
  expect(JSON.stringify(profile)).not.toContain("test-only-password");
});

it("offers pairing-code records only for permanent remote device identities", () => {
  const profile = createConnectionProfile(emptyDraft("lattice"), "profile");
  expect(supportsCredentialRecord(profile)).toBe(false);
  expect(supportsCredentialRecord({ ...profile, deviceId: "123456789" })).toBe(true);
});

it("does not expose an old saved login after the endpoint is edited", () => {
  const profile = createConnectionProfile(emptyDraft(), "profile");
  expect(sameCredentialTarget(profile, { ...profile, name: "Renamed" })).toBe(true);
  for (const change of [{ hostname: "other.example" }, { username: "other-user" }, { port: 2222 }, { protocol: "sftp" as const }, { deviceId: "123456789" }]) {
    expect(sameCredentialTarget(profile, { ...profile, ...change })).toBe(false);
  }
});
