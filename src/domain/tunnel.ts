import { formatDecimal } from "./localizedNumbers";
import type { MessageKey } from "../i18n/messages/zh-TW";
/**
 * SSH Tunnel & Port Forwarding domain model.
 *
 * Defines the types, validation rules, and helpers for Local, Remote,
 * and Dynamic (SOCKS5) port forwarding configurations.
 */

export type TunnelType = "local" | "remote" | "dynamic";

export type TunnelStatus = "stopped" | "starting" | "active" | "error";

export interface TunnelStats {
  bytesUploaded: number;
  bytesDownloaded: number;
  activeConnections: number;
  startedAt?: number;
  lastError?: string;
}

export interface TunnelConfig {
  id: string;
  name: string;
  type: TunnelType;
  /** Connection Profile ID used as the SSH Jump / Gateway host */
  profileId: string;
  /** Local bind address (e.g. '127.0.0.1' or '0.0.0.0') */
  localHost: string;
  /** Local listening port (1 - 65535) */
  localPort: number;
  /** Remote target host (used for local & remote forwarding, e.g. 'localhost' or '10.0.0.5') */
  remoteHost: string;
  /** Remote target port (used for local & remote forwarding, e.g. 5432, 3306) */
  remotePort: number;
  /** Automatically start tunnel when LatticeTerm starts */
  autoStart?: boolean;
  /** Optional description or notes */
  description?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TunnelDraft {
  name: string;
  type: TunnelType;
  profileId: string;
  localHost: string;
  localPort: string | number;
  remoteHost: string;
  remotePort: string | number;
  autoStart?: boolean;
  description?: string;
}

export interface TunnelValidationError {
  field: keyof TunnelDraft;
  messageKey: MessageKey;
}

/**
 * Validates a port string or number (1 - 65535).
 */
export function isValidPort(port: string | number): boolean {
  const num = typeof port === "number" ? port : parseInt(port.trim(), 10);
  return !isNaN(num) && num >= 1 && num <= 65535 && String(num) === String(port).trim();
}

/**
 * Bind addresses are passed to the native socket API, so accept IP literals
 * only. Hostnames such as `localhost` can resolve differently and accidentally
 * expose a listener on an unintended interface.
 */
export function isIpLiteral(value: string): boolean {
  const candidate = value.trim();
  const octets = candidate.split(".");
  if (octets.length === 4) {
    return octets.every(
      (octet) => /^\d{1,3}$/.test(octet) && Number(octet) >= 0 && Number(octet) <= 255,
    );
  }

  if (!candidate.includes(":")) return false;
  try {
    // WHATWG URL parsing provides a well-tested IPv6 parser in browsers and
    // in the Vitest runtime. Brackets are added only for parsing.
    new URL(`http://[${candidate}]/`);
    return true;
  } catch {
    return false;
  }
}

export function isLoopbackIp(value: string): boolean {
  const candidate = value.trim().toLowerCase();
  if (candidate.includes(".")) {
    return isIpLiteral(candidate) && candidate.split(".")[0] === "127";
  }
  if (!isIpLiteral(candidate)) return false;
  try {
    return new URL(`http://[${candidate}]/`).hostname === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Validates a tunnel draft and returns a list of validation errors.
 */
export function validateTunnelDraft(draft: TunnelDraft): TunnelValidationError[] {
  const errors: TunnelValidationError[] = [];

  if (!draft.name || draft.name.trim().length === 0) {
    errors.push({ field: "name", messageKey: "tunnels.error.nameRequired" });
  }

  if (!draft.profileId || draft.profileId.trim().length === 0) {
    errors.push({ field: "profileId", messageKey: "tunnels.error.profileRequired" });
  }

  if (!draft.localHost || draft.localHost.trim().length === 0) {
    errors.push({ field: "localHost", messageKey: "tunnels.error.localHostRequired" });
  } else if (!isIpLiteral(draft.localHost)) {
    errors.push({ field: "localHost", messageKey: "tunnels.error.invalidBindIp" });
  } else if (draft.type === "dynamic" && !isLoopbackIp(draft.localHost)) {
    errors.push({ field: "localHost", messageKey: "tunnels.error.dynamicLoopback" });
  }

  if (!isValidPort(draft.localPort)) {
    errors.push({ field: "localPort", messageKey: "tunnels.error.invalidLocalPort" });
  }

  if (draft.type === "local" || draft.type === "remote") {
    if (!draft.remoteHost || draft.remoteHost.trim().length === 0) {
      errors.push({ field: "remoteHost", messageKey: "tunnels.error.remoteHostRequired" });
    }
    if (!isValidPort(draft.remotePort)) {
      errors.push({ field: "remotePort", messageKey: "tunnels.error.invalidRemotePort" });
    }
  }

  return errors;
}

/**
 * Constructs a new TunnelConfig from a validated draft.
 */
export function createTunnelFromDraft(
  draft: TunnelDraft,
  existingId?: string,
): TunnelConfig {
  const now = Date.now();
  return {
    id: existingId ?? `tunnel-${now}-${Math.random().toString(36).substring(2, 7)}`,
    name: draft.name.trim(),
    type: draft.type,
    profileId: draft.profileId.trim(),
    localHost: draft.localHost.trim() || "127.0.0.1",
    localPort: typeof draft.localPort === "number" ? draft.localPort : parseInt(draft.localPort.trim(), 10),
    remoteHost: draft.type === "dynamic" ? "" : draft.remoteHost.trim(),
    remotePort: draft.type === "dynamic" ? 0 : (typeof draft.remotePort === "number" ? draft.remotePort : parseInt(draft.remotePort.trim(), 10)),
    autoStart: Boolean(draft.autoStart),
    description: draft.description?.trim(),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Generates the equivalent OpenSSH command line string for quick copying.
 */
export function formatSshTunnelCommand(
  tunnel: TunnelConfig,
  gatewayUser = "user",
  gatewayHost = "gateway.example.com",
  gatewayPort = 22,
): string {
  const portArg = gatewayPort !== 22 ? ` -p ${gatewayPort}` : "";
  const hostTarget = `${gatewayUser}@${gatewayHost}${portArg}`;

  switch (tunnel.type) {
    case "local": {
      const bind = tunnel.localHost !== "127.0.0.1" && tunnel.localHost !== "localhost" ? `${tunnel.localHost}:` : "";
      return `ssh -L ${bind}${tunnel.localPort}:${tunnel.remoteHost}:${tunnel.remotePort} ${hostTarget} -N`;
    }
    case "remote": {
      const bind = tunnel.localHost !== "127.0.0.1" && tunnel.localHost !== "localhost" ? `${tunnel.localHost}:` : "";
      return `ssh -R ${bind}${tunnel.localPort}:${tunnel.remoteHost}:${tunnel.remotePort} ${hostTarget} -N`;
    }
    case "dynamic": {
      const bind = tunnel.localHost !== "127.0.0.1" && tunnel.localHost !== "localhost" ? `${tunnel.localHost}:` : "";
      return `ssh -D ${bind}${tunnel.localPort} ${hostTarget} -N`;
    }
  }
}

/**
 * Formats byte counts into human-readable strings (KB, MB, GB).
 */
export function formatBytes(bytes: number, locale?: string): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${formatDecimal(bytes, 0, locale)} B`;
  if (bytes < 1024 * 1024) return `${formatDecimal(bytes / 1024, 1, locale)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${formatDecimal(bytes / (1024 * 1024), 1, locale)} MB`;
  return `${formatDecimal(bytes / (1024 * 1024 * 1024), 2, locale)} GB`;
}
