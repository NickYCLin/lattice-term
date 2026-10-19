import { isValidPort, type TunnelConfig } from "../domain/tunnel";

export const TUNNELS_STORAGE_KEY = "latticeterm.tunnels.v1";

function isTunnelConfig(value: unknown): value is TunnelConfig {
  if (!value || typeof value !== "object") return false;
  const tunnel = value as Record<string, unknown>;
  return ["id", "name", "profileId", "localHost", "remoteHost"].every(field => typeof tunnel[field] === "string")
    && Boolean((tunnel.id as string).trim())
    && (tunnel.type === "local" || tunnel.type === "remote" || tunnel.type === "dynamic")
    && typeof tunnel.localPort === "number" && isValidPort(tunnel.localPort)
    && typeof tunnel.remotePort === "number"
    && (tunnel.type === "dynamic" ? tunnel.remotePort === 0 : isValidPort(tunnel.remotePort))
    && (tunnel.autoStart === undefined || typeof tunnel.autoStart === "boolean")
    && (tunnel.description === undefined || typeof tunnel.description === "string")
    && typeof tunnel.createdAt === "number" && Number.isFinite(tunnel.createdAt)
    && typeof tunnel.updatedAt === "number" && Number.isFinite(tunnel.updatedAt);
}

export function readTunnelStore(): { tunnels: TunnelConfig[]; storageError: boolean } {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(TUNNELS_STORAGE_KEY);
    if (raw === null) return { tunnels: [], storageError: false };
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isTunnelConfig)
      || new Set(parsed.map(tunnel => tunnel.id)).size !== parsed.length) {
      return { tunnels: [], storageError: true };
    }
    return { tunnels: parsed, storageError: false };
  } catch {
    return { tunnels: [], storageError: true };
  }
}
