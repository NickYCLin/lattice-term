import { describe, expect, it } from "vitest";
import {
  createTunnelFromDraft,
  formatBytes,
  formatSshTunnelCommand,
  isIpLiteral,
  isLoopbackIp,
  isValidPort,
  validateTunnelDraft,
  type TunnelConfig,
  type TunnelDraft,
} from "./tunnel";
import {
  requestTunnelStop,
  tunnelRequiresStopBeforeDelete,
  tunnelStateAfterStopFailure,
} from "../app/useTunnels";

describe("tunnel domain model", () => {
  it("rejects fractional numeric ports in both forwarding endpoints", () => {
    expect(isValidPort(8080.5)).toBe(false);
    expect(isValidPort("8080.5")).toBe(false);
    const errors = validateTunnelDraft({
      name: "Fractional ports", type: "local", profileId: "gateway",
      localHost: "127.0.0.1", localPort: 8080.5,
      remoteHost: "localhost", remotePort: 80.5,
    });
    expect(errors.map(error => error.field)).toEqual(["localPort", "remotePort"]);
  });

  it.each(["local", "remote", "dynamic"] as const)("brackets IPv6 addresses in %s forwarding commands", type => {
    const tunnel: TunnelConfig = {
      id: "ipv6", name: "IPv6", type, profileId: "gateway",
      localHost: "::1", localPort: 8080, remoteHost: "2001:db8::2",
      remotePort: 80, createdAt: 1, updatedAt: 1,
    };
    const forwarding = type === "dynamic" ? "-D [::1]:8080"
      : `-${type === "local" ? "L" : "R"} [::1]:8080:[2001:db8::2]:80`;
    expect(formatSshTunnelCommand(tunnel, "tester", "gateway.example", 2222))
      .toBe(`ssh ${forwarding} tester@gateway.example -p 2222 -N`);
    expect(formatSshTunnelCommand({ ...tunnel, remoteHost: "[2001:db8::2]" }, "tester", "gateway.example", 2222))
      .toBe(`ssh ${forwarding} tester@gateway.example -p 2222 -N`);
  });

  it("validates ports accurately within 1 - 65535", () => {
    expect(isValidPort(1)).toBe(true);
    expect(isValidPort(22)).toBe(true);
    expect(isValidPort(65535)).toBe(true);
    expect(isValidPort("8080")).toBe(true);

    expect(isValidPort(0)).toBe(false);
    expect(isValidPort(65536)).toBe(false);
    expect(isValidPort(-1)).toBe(false);
    expect(isValidPort("abc")).toBe(false);
    expect(isValidPort("")).toBe(false);
    expect(isValidPort("80.5")).toBe(false);
  });

  it("accepts only literal bind addresses and identifies loopback ranges", () => {
    expect(isIpLiteral("127.0.0.1")).toBe(true);
    expect(isIpLiteral("0.0.0.0")).toBe(true);
    expect(isIpLiteral("::1")).toBe(true);
    expect(isIpLiteral("2001:db8::1")).toBe(true);
    expect(isIpLiteral("localhost")).toBe(false);
    expect(isIpLiteral("999.0.0.1")).toBe(false);
    expect(isIpLiteral("1:2:3")).toBe(false);

    expect(isLoopbackIp("127.20.30.40")).toBe(true);
    expect(isLoopbackIp("::1")).toBe(true);
    expect(isLoopbackIp("0.0.0.0")).toBe(false);
    expect(isLoopbackIp("2001:db8::1")).toBe(false);
  });

  it("validates a complete local tunnel draft successfully", () => {
    const draft: TunnelDraft = {
      name: "PostgreSQL Tunnel",
      type: "local",
      profileId: "profile-123",
      localHost: "127.0.0.1",
      localPort: 5432,
      remoteHost: "db-internal.internal",
      remotePort: 5432,
    };

    const errors = validateTunnelDraft(draft);
    expect(errors).toHaveLength(0);

    const tunnel = createTunnelFromDraft(draft);
    expect(tunnel.name).toBe("PostgreSQL Tunnel");
    expect(tunnel.type).toBe("local");
    expect(tunnel.localPort).toBe(5432);
    expect(tunnel.remoteHost).toBe("db-internal.internal");
    expect(tunnel.remotePort).toBe(5432);
  });

  it("catches missing required fields in tunnel draft", () => {
    const invalidDraft: TunnelDraft = {
      name: "",
      type: "local",
      profileId: "",
      localHost: "",
      localPort: "invalid",
      remoteHost: "",
      remotePort: 999999,
    };

    const errors = validateTunnelDraft(invalidDraft);
    expect(errors.map((e) => e.field)).toEqual([
      "name",
      "profileId",
      "localHost",
      "localPort",
      "remoteHost",
      "remotePort",
    ]);
  });

  it("does not require remote target for dynamic SOCKS5 tunnels", () => {
    const dynamicDraft: TunnelDraft = {
      name: "SOCKS5 Proxy",
      type: "dynamic",
      profileId: "profile-jump",
      localHost: "127.0.0.1",
      localPort: 1080,
      remoteHost: "",
      remotePort: "",
    };

    const errors = validateTunnelDraft(dynamicDraft);
    expect(errors).toHaveLength(0);

    const tunnel = createTunnelFromDraft(dynamicDraft);
    expect(tunnel.type).toBe("dynamic");
    expect(tunnel.localPort).toBe(1080);
    expect(tunnel.remoteHost).toBe("");
    expect(tunnel.remotePort).toBe(0);
  });

  it("rejects a no-authentication SOCKS5 proxy on a public bind address", () => {
    const draft: TunnelDraft = {
      name: "Unsafe SOCKS5 Proxy",
      type: "dynamic",
      profileId: "profile-jump",
      localHost: "0.0.0.0",
      localPort: 1080,
      remoteHost: "",
      remotePort: "",
    };

    expect(validateTunnelDraft(draft)).toContainEqual({
      field: "localHost",
      messageKey: "tunnels.error.dynamicLoopback",
    });
  });

  it("generates correct OpenSSH command line equivalents", () => {
    const localTunnel: TunnelConfig = {
      id: "t1",
      name: "Local Web",
      type: "local",
      profileId: "p1",
      localHost: "127.0.0.1",
      localPort: 8080,
      remoteHost: "10.0.0.2",
      remotePort: 80,
      createdAt: 1000,
      updatedAt: 1000,
    };

    const cmdLocal = formatSshTunnelCommand(localTunnel, "admin", "gateway.cloud", 2222);
    expect(cmdLocal).toBe("ssh -L 8080:10.0.0.2:80 admin@gateway.cloud -p 2222 -N");

    const dynamicTunnel: TunnelConfig = {
      id: "t2",
      name: "Dynamic Proxy",
      type: "dynamic",
      profileId: "p1",
      localHost: "0.0.0.0",
      localPort: 1080,
      remoteHost: "",
      remotePort: 0,
      createdAt: 1000,
      updatedAt: 1000,
    };

    const cmdDynamic = formatSshTunnelCommand(dynamicTunnel, "root", "vpn.corp.net", 22);
    expect(cmdDynamic).toBe("ssh -D 0.0.0.0:1080 root@vpn.corp.net -N");
  });

  it("formats byte statistics cleanly", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(2097152)).toBe("2.0 MB");
    expect(formatBytes(10737418240)).toBe("10.00 GB");
  });
});

describe("tunnel runtime lifecycle", () => {
  it("requires a confirmed stop before deleting active or starting tunnels", () => {
    expect(tunnelRequiresStopBeforeDelete("active")).toBe(true);
    expect(tunnelRequiresStopBeforeDelete("starting")).toBe(true);
    expect(tunnelRequiresStopBeforeDelete("stopped")).toBe(false);
    expect(tunnelRequiresStopBeforeDelete("error")).toBe(false);
    expect(tunnelRequiresStopBeforeDelete(undefined)).toBe(false);
  });

  it("keeps an active tunnel active when stopping fails", () => {
    expect(
      tunnelStateAfterStopFailure(
        {
          status: "active",
          bytesUploaded: 12,
          bytesDownloaded: 34,
          activeConnections: 2,
          startedAt: 1000,
        },
        "stop:backend unreachable",
      ),
    ).toEqual({
      status: "active",
      bytesUploaded: 12,
      bytesDownloaded: 34,
      activeConnections: 2,
      startedAt: 1000,
      lastError: "stop:backend unreachable",
    });
  });

  it("preserves a backend stop failure instead of reporting success", async () => {
    const result = await requestTunnelStop(
      "tunnel-1",
      async (command, args) => {
        expect(command).toBe("tunnel_stop");
        expect(args).toEqual({ tunnelId: "tunnel-1" });
        throw new Error("backend unreachable");
      },
    );

    expect(result).toEqual({
      success: false,
      error: "stop:backend unreachable",
    });
  });

  it("reports success only after the backend accepted the stop", async () => {
    const result = await requestTunnelStop("tunnel-1", async () => undefined);
    expect(result).toEqual({ success: true });
  });
});
