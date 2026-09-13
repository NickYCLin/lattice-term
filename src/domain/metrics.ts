import { formatDecimal } from "./localizedNumbers";
/**
 * Host resource readings: processor, memory and disk usage for one host.
 *
 * Where this belongs: resources describe a *host*, and they can only be read
 * over an established session, so they live on the connection inspector's
 * "host status" tab rather than in a global dashboard. The shapes here are
 * what the SSH engine will fill in once sessions exist; until then the state
 * is `unavailable` and the interface says so instead of inventing numbers.
 *
 * Nothing in this module reads a command's output — parsing belongs to the
 * engine, so these types stay independent of how a given OS reports usage.
 */

export interface CpuReading {
  /** 0-100 across all cores. */
  usagePercent: number;
  cores: number;
  model?: string;
  /** 1, 5 and 15 minute load averages where the platform reports them. */
  loadAverage?: [number, number, number];
}

export interface MemoryReading {
  totalBytes: number;
  usedBytes: number;
}

export interface DiskReading {
  mountpoint: string;
  filesystem?: string;
  totalBytes: number;
  usedBytes: number;
}

export interface HostMetrics {
  /** Milliseconds since the epoch, stamped when the reading was taken. */
  collectedAt: number;
  uptimeSeconds: number;
  cpu: CpuReading;
  memory: MemoryReading;
  swap?: MemoryReading;
  disks: DiskReading[];
}

export type MetricsState =
  /** No session, so nothing can be read. The state of every host today. */
  | { status: "unavailable"; reason: "not-connected" | "not-supported" }
  | { status: "loading" }
  | { status: "ready"; metrics: HostMetrics }
  | { status: "error"; detail: string };

export const initialMetricsState: MetricsState = {
  status: "unavailable",
  reason: "not-connected",
};

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/**
 * Human-readable size using 1024 steps. Values below 10 in their unit keep one
 * decimal, so 9.4 GB stays precise while 421 GB stays short.
 *
 * Locale-aware decimals use cached formatters for frequent progress updates.
 */
export function formatBytes(bytes: number, locale?: string): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes === 0) return `0 ${UNITS[0]}`;

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  const digits = unit === 0 ? 0 : value < 10 ? 1 : 0;

  return `${formatDecimal(value, digits, locale)} ${UNITS[unit]}`;
}

/** Used share of a total, clamped to 0-100 and safe when the total is zero. */
export function usagePercent(used: number, total: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((used / total) * 100)));
}

export type UsageLevel = "normal" | "warning" | "critical";

/**
 * Severity band for a usage figure. Paired with a numeric label everywhere it
 * is shown, so the band is never the only signal.
 */
export function usageLevel(percent: number): UsageLevel {
  if (percent >= 90) return "critical";
  if (percent >= 75) return "warning";
  return "normal";
}

export interface UptimeParts {
  days: number;
  hours: number;
  minutes: number;
}

export function splitUptime(seconds: number): UptimeParts {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return {
    days: Math.floor(safe / 86400),
    hours: Math.floor((safe % 86400) / 3600),
    minutes: Math.floor((safe % 3600) / 60),
  };
}

/** Largest disks first: the ones most likely to matter when space runs out. */
export function sortDisks(disks: DiskReading[]): DiskReading[] {
  return [...disks].sort((a, b) => {
    const byUsage =
      usagePercent(b.usedBytes, b.totalBytes) -
      usagePercent(a.usedBytes, a.totalBytes);
    if (byUsage !== 0) return byUsage;
    return b.totalBytes - a.totalBytes;
  });
}
