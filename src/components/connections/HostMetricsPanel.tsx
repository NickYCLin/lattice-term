/**
 * Host resources for the selected connection.
 *
 * Renders whatever state the reading is in. The full cards belong in the
 * connection inspector; the compact variant docks below the SSH file browser.
 */

import {
  formatBytes,
  sortDisks,
  splitUptime,
  usageLevel,
  usagePercent,
  type HostMetrics,
  type MetricsState,
} from "../../domain/metrics";
import { useI18n } from "../../i18n/context";
import { Callout } from "../common/Callout";
import { ClockIcon, CpuIcon, DiskIcon, MemoryIcon } from "../icons";
import { useId, useState, type ReactNode } from "react";

function Meter({ percent }: { percent: number }) {
  const level = usageLevel(percent);
  return (
    <div
      className={`meter meter--${level}`}
      role="meter"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="meter__fill" style={{ width: `${percent}%` }} />
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  detail,
  percent,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail?: string;
  percent?: number;
}) {
  return (
    <div className="metric-card">
      <div className="metric-card__head">
        <span style={{ display: "flex", color: "var(--text-faint)" }}>
          {icon}
        </span>
        <span className="metric-card__label">{label}</span>
        <span className="metric-card__value">{value}</span>
      </div>
      {percent !== undefined && <Meter percent={percent} />}
      {detail && <span className="metric-card__detail">{detail}</span>}
    </div>
  );
}

interface CompactMetricDetail {
  id: string;
  label: string;
  value: string;
  detail: string;
  percent?: number;
}

function CompactMetric({
  icon,
  detail,
  active,
  tooltipId,
  onActive,
}: {
  icon: ReactNode;
  detail: CompactMetricDetail;
  active: boolean;
  tooltipId: string;
  onActive: (detail: CompactMetricDetail | null) => void;
}) {
  return (
    <button
      type="button"
      className={`host-metrics-compact__item${active ? " is-active" : ""}`}
      aria-label={`${detail.label}: ${detail.value}. ${detail.detail}`}
      aria-expanded={active}
      aria-describedby={active ? tooltipId : undefined}
      onMouseEnter={() => onActive(detail)}
      onMouseLeave={() => onActive(null)}
      onFocus={() => onActive(detail)}
      onBlur={() => onActive(null)}
      onClick={() => onActive(active ? null : detail)}
    >
      <span className="host-metrics-compact__icon" aria-hidden="true">
        {icon}
      </span>
      <strong>{detail.value}</strong>
      {detail.percent !== undefined && (
        <span className="host-metrics-compact__meter" aria-hidden="true">
          <span
            className={`meter--${usageLevel(detail.percent)}`}
            style={{ width: `${detail.percent}%` }}
          />
        </span>
      )}
    </button>
  );
}

function CompactHostMetrics({ metrics }: { metrics: HostMetrics }) {
  const { t, tag } = useI18n();
  const tooltipId = useId();
  const [active, setActive] = useState<CompactMetricDetail | null>(null);
  const memoryPercent = usagePercent(
    metrics.memory.usedBytes,
    metrics.memory.totalBytes,
  );
  const uptime = splitUptime(metrics.uptimeSeconds);
  const uptimeValue =
    uptime.days > 0
      ? t("metrics.uptimeValue", {
          days: uptime.days,
          hours: uptime.hours,
        })
      : t("metrics.uptimeHours", {
          hours: uptime.hours,
          minutes: uptime.minutes,
        });
  const updated = t("metrics.lastUpdated", {
    time: new Date(metrics.collectedAt).toLocaleTimeString(tag, {
      hour: "2-digit",
      minute: "2-digit",
    }),
  });
  const cpuPercent = Math.round(metrics.cpu.usagePercent);
  const cpu: CompactMetricDetail = {
    id: "cpu",
    label: t("metrics.cpu"),
    value: `${cpuPercent}%`,
    detail: [
      metrics.cpu.model,
      t("metrics.cores", { count: metrics.cpu.cores }),
      metrics.cpu.loadAverage
        ? `${t("metrics.load")} ${metrics.cpu.loadAverage.join(" / ")}`
        : undefined,
    ]
      .filter(Boolean)
      .join(" · "),
    percent: cpuPercent,
  };
  const memory: CompactMetricDetail = {
    id: "memory",
    label: t("metrics.memory"),
    value: `${memoryPercent}%`,
    detail: t("metrics.usedOfTotal", {
      used: formatBytes(metrics.memory.usedBytes, tag),
      total: formatBytes(metrics.memory.totalBytes, tag),
    }),
    percent: memoryPercent,
  };
  const disks = sortDisks(metrics.disks).map<CompactMetricDetail>((disk) => {
    const percent = usagePercent(disk.usedBytes, disk.totalBytes);
    return {
      id: `disk:${disk.mountpoint}`,
      label: `${t("metrics.disk")} ${disk.mountpoint}`,
      value: `${percent}%`,
      detail: [
        disk.filesystem,
        t("metrics.usedOfTotal", {
          used: formatBytes(disk.usedBytes, tag),
          total: formatBytes(disk.totalBytes, tag),
        }),
      ]
        .filter(Boolean)
        .join(" · "),
      percent,
    };
  });
  const timingDetail = `${t("metrics.uptime")}: ${uptimeValue} · ${updated}`;

  return (
    <div className="host-metrics-compact" aria-label={t("metrics.title")}>
      <div className="host-metrics-compact__row">
        <CompactMetric
          icon={<CpuIcon size={12} />}
          detail={cpu}
          active={active?.id === cpu.id}
          tooltipId={tooltipId}
          onActive={setActive}
        />
        <CompactMetric
          icon={<MemoryIcon size={12} />}
          detail={memory}
          active={active?.id === memory.id}
          tooltipId={tooltipId}
          onActive={setActive}
        />
        {disks.map((disk) => (
          <CompactMetric
            key={disk.id}
            icon={<DiskIcon size={12} />}
            detail={disk}
            active={active?.id === disk.id}
            tooltipId={tooltipId}
            onActive={setActive}
          />
        ))}
      </div>
      {active && (
        <div
          className="host-metrics-compact__tooltip"
          id={tooltipId}
          role="tooltip"
        >
          <span>
            <strong>{active.label}</strong>
            <b>{active.value}</b>
          </span>
          {active.percent !== undefined && <Meter percent={active.percent} />}
          <small>{active.detail}</small>
          <small>{timingDetail}</small>
        </div>
      )}
    </div>
  );
}

export function HostMetricsPanel({
  state,
  variant = "cards",
}: {
  state: MetricsState;
  variant?: "cards" | "compact";
}) {
  const { t, tag } = useI18n();

  if (variant === "compact" && state.status !== "ready") {
    const message =
      state.status === "loading"
        ? t("common.detecting")
        : state.status === "error"
          ? state.detail
          : state.reason === "not-supported"
            ? t("metrics.notSupported.body")
            : t("metrics.notConnected.title");
    return (
      <div
        className={`host-metrics-compact__state${
          state.status === "error" ? " is-error" : ""
        }`}
        title={message}
      >
        <CpuIcon size={12} />
        <span className="truncate">{message}</span>
      </div>
    );
  }

  if (state.status === "unavailable") {
    return state.reason === "not-supported" ? (
      <Callout tone="info" title={t("metrics.title")}>
        {t("metrics.notSupported.body")}
      </Callout>
    ) : (
      <Callout tone="info" title={t("metrics.notConnected.title")}>
        {t("metrics.notConnected.body")}
      </Callout>
    );
  }

  if (state.status === "loading") {
    return <p className="text-faint">{t("common.detecting")}</p>;
  }

  if (state.status === "error") {
    return (
      <Callout tone="danger" title={t("metrics.title")}>
        {state.detail}
      </Callout>
    );
  }

  const { metrics } = state;
  if (variant === "compact") {
    return <CompactHostMetrics metrics={metrics} />;
  }
  const memoryPercent = usagePercent(
    metrics.memory.usedBytes,
    metrics.memory.totalBytes,
  );
  const uptime = splitUptime(metrics.uptimeSeconds);

  return (
    <div className="inspector__section">
      <MetricCard
        icon={<CpuIcon size={14} />}
        label={t("metrics.cpu")}
        value={`${Math.round(metrics.cpu.usagePercent)}%`}
        detail={[
          t("metrics.cores", { count: metrics.cpu.cores }),
          metrics.cpu.loadAverage
            ? `${t("metrics.load")} ${metrics.cpu.loadAverage.join(" / ")}`
            : undefined,
        ]
          .filter(Boolean)
          .join(" · ")}
        percent={Math.round(metrics.cpu.usagePercent)}
      />

      <MetricCard
        icon={<MemoryIcon size={14} />}
        label={t("metrics.memory")}
        value={t("metrics.percentUsed", { percent: memoryPercent })}
        detail={t("metrics.usedOfTotal", {
          used: formatBytes(metrics.memory.usedBytes, tag),
          total: formatBytes(metrics.memory.totalBytes, tag),
        })}
        percent={memoryPercent}
      />

      {sortDisks(metrics.disks).map((disk) => {
        const percent = usagePercent(disk.usedBytes, disk.totalBytes);
        return (
          <MetricCard
            key={disk.mountpoint}
            icon={<DiskIcon size={14} />}
            label={`${t("metrics.disk")} ${disk.mountpoint}`}
            value={t("metrics.percentUsed", { percent })}
            detail={t("metrics.usedOfTotal", {
              used: formatBytes(disk.usedBytes, tag),
              total: formatBytes(disk.totalBytes, tag),
            })}
            percent={percent}
          />
        );
      })}

      <MetricCard
        icon={<ClockIcon size={14} />}
        label={t("metrics.uptime")}
        value={
          uptime.days > 0
            ? t("metrics.uptimeValue", {
                days: uptime.days,
                hours: uptime.hours,
              })
            : t("metrics.uptimeHours", {
                hours: uptime.hours,
                minutes: uptime.minutes,
              })
        }
      />
    </div>
  );
}
