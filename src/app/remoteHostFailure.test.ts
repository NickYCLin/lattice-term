import { describe, expect, it } from "vitest";
import { isRelayDnsFailure } from "./remoteHostFailure";

describe("isRelayDnsFailure", () => {
  it.each([
    "relay.IO error: 無法識別遠台主機。(os error 11001)",
    "relay: I/O error: No such host is known. (os error 11001)",
    "relay: I/O error: failed to lookup address information: Name or service not known",
  ])("recognizes relay hostname lookup failures: %s", (reason) => {
    expect(isRelayDnsFailure(reason)).toBe(true);
  });

  it.each([
    null,
    "relay: I/O error: Connection refused (os error 10061)",
    "relay: the relay sent an unexpected message",
    "credential: I/O error: No such host is known (os error 11001)",
  ])("leaves unrelated errors intact: %s", (reason) => {
    expect(isRelayDnsFailure(reason)).toBe(false);
  });
});
