//! Host resource readings over an existing SSH session.
//!
//! A probe script runs once per request on its own exec channel, so the
//! user's terminal never sees it. Everything is read from `/proc` and
//! `df -P`, which makes the readings Linux-specific by design: a host that
//! does not produce that output gets an honest "not supported" error instead
//! of numbers guessed from partial data.
//!
//! Processor usage is a real measurement — two `/proc/stat` samples one
//! second apart — not an instantaneous figure, so a single request takes
//! roughly a second to answer.

use crate::ssh::{SshRegistry, TrustingHandler};
use russh::client;
use russh::ChannelMsg;
use serde::Serialize;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// How long the whole probe may take, including its built-in one-second wait.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
/// An output cap: `/proc` files are tiny, so anything larger is not a Linux
/// metrics answer and refusing early protects memory.
const MAX_PROBE_OUTPUT: usize = 256 * 1024;
/// More mounts than this is noise; the interface sorts by fullest first.
const MAX_DISKS: usize = 16;

/// One section marker per reading keeps the parser independent of ordering
/// quirks and of commands that fail and print nothing.
const PROBE: &str = concat!(
    "export LC_ALL=C; ",
    "echo '===UPTIME'; cat /proc/uptime 2>/dev/null; ",
    "echo '===LOAD'; cat /proc/loadavg 2>/dev/null; ",
    "echo '===CORES'; nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null; ",
    "echo '===MODEL'; sed -n 's/^model name[^:]*: //p' /proc/cpuinfo 2>/dev/null | head -n 1; ",
    "echo '===STAT1'; head -n 1 /proc/stat 2>/dev/null; ",
    "sleep 1; ",
    "echo '===STAT2'; head -n 1 /proc/stat 2>/dev/null; ",
    "echo '===MEMINFO'; cat /proc/meminfo 2>/dev/null; ",
    "echo '===DF'; df -P -k 2>/dev/null",
);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuPayload {
    pub usage_percent: f64,
    pub cores: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load_average: Option<[f64; 3]>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryPayload {
    pub total_bytes: u64,
    pub used_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskPayload {
    pub mountpoint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filesystem: Option<String>,
    pub total_bytes: u64,
    pub used_bytes: u64,
}

/// Mirrors `HostMetrics` in `src/domain/metrics.ts`; the field names are the
/// contract the interface reads by.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostMetricsPayload {
    /// Milliseconds since the epoch, stamped when the reading finished.
    pub collected_at: u64,
    pub uptime_seconds: u64,
    pub cpu: CpuPayload,
    pub memory: MemoryPayload,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub swap: Option<MemoryPayload>,
    pub disks: Vec<DiskPayload>,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Splits the probe output into its marked sections.
fn section<'a>(output: &'a str, marker: &str) -> Option<&'a str> {
    let start = output.find(marker)? + marker.len();
    let rest = &output[start..];
    let end = rest.find("===").unwrap_or(rest.len());
    Some(rest[..end].trim())
}

fn first_number(text: &str) -> Option<f64> {
    text.split_whitespace().next()?.parse().ok()
}

/// `cpu  user nice system idle iowait ...` → (busy jiffies, total jiffies).
fn parse_stat_line(line: &str) -> Option<(u64, u64)> {
    let mut fields = line.split_whitespace();
    if fields.next()? != "cpu" {
        return None;
    }
    let values: Vec<u64> = fields.filter_map(|field| field.parse().ok()).collect();
    if values.len() < 4 {
        return None;
    }
    let total: u64 = values.iter().sum();
    // idle + iowait count as not-busy; everything else is work.
    let idle = values[3] + values.get(4).copied().unwrap_or(0);
    Some((total - idle, total))
}

fn meminfo_kib(text: &str, key: &str) -> Option<u64> {
    text.lines().find_map(|line| {
        let rest = line.strip_prefix(key)?.strip_prefix(':')?;
        first_number(rest).map(|value| value as u64)
    })
}

fn parse_disks(text: &str) -> Vec<DiskPayload> {
    let mut disks: Vec<DiskPayload> = Vec::new();
    for line in text.lines().skip(1) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 6 {
            continue;
        }
        let filesystem = fields[0];
        // Real storage appears as a device path; tmpfs, cgroups and the rest
        // of the pseudo-filesystem zoo would only bury the disks that matter.
        if !filesystem.starts_with('/') {
            continue;
        }
        let (Ok(total_kib), Ok(used_kib)) = (fields[1].parse::<u64>(), fields[2].parse::<u64>())
        else {
            continue;
        };
        if total_kib == 0 {
            continue;
        }
        let mountpoint = fields[5..].join(" ");
        if disks.iter().any(|disk| disk.mountpoint == mountpoint) {
            continue;
        }
        disks.push(DiskPayload {
            mountpoint,
            filesystem: Some(filesystem.to_string()),
            total_bytes: total_kib * 1024,
            used_bytes: used_kib * 1024,
        });
        if disks.len() == MAX_DISKS {
            break;
        }
    }
    disks
}

/// Turns raw probe output into the payload, or explains why it cannot.
pub fn parse_metrics(output: &str, collected_at: u64) -> Result<HostMetricsPayload, String> {
    let meminfo = section(output, "===MEMINFO").unwrap_or("");
    let total_kib = meminfo_kib(meminfo, "MemTotal");
    let uptime = section(output, "===UPTIME").and_then(first_number);

    // Both readings come straight from /proc; a host with neither is not a
    // Linux host, and partial guesses would be worse than saying so.
    let (Some(total_kib), Some(uptime)) = (total_kib, uptime) else {
        return Err(
            "The host did not report Linux /proc data — resource readings need a Linux host."
                .to_string(),
        );
    };

    let available_kib = meminfo_kib(meminfo, "MemAvailable")
        .or_else(|| meminfo_kib(meminfo, "MemFree"))
        .unwrap_or(0);
    let memory = MemoryPayload {
        total_bytes: total_kib * 1024,
        used_bytes: (total_kib.saturating_sub(available_kib)) * 1024,
    };

    let swap = match (
        meminfo_kib(meminfo, "SwapTotal"),
        meminfo_kib(meminfo, "SwapFree"),
    ) {
        (Some(total), Some(free)) if total > 0 => Some(MemoryPayload {
            total_bytes: total * 1024,
            used_bytes: total.saturating_sub(free) * 1024,
        }),
        _ => None,
    };

    let cores = section(output, "===CORES")
        .and_then(first_number)
        .map(|value| value as u32)
        .filter(|value| *value >= 1)
        .unwrap_or(1);

    let load_average = section(output, "===LOAD").and_then(|text| {
        let mut values = text
            .split_whitespace()
            .filter_map(|f| f.parse::<f64>().ok());
        Some([values.next()?, values.next()?, values.next()?])
    });

    let model = section(output, "===MODEL")
        .filter(|text| !text.is_empty())
        .map(|text| text.to_string());

    let stat1 = section(output, "===STAT1").and_then(parse_stat_line);
    let stat2 = section(output, "===STAT2").and_then(parse_stat_line);
    let usage_percent = match (stat1, stat2) {
        // The honest reading: how busy the processor was between the samples.
        (Some((busy1, total1)), Some((busy2, total2))) if total2 > total1 => {
            (busy2.saturating_sub(busy1)) as f64 / (total2 - total1) as f64 * 100.0
        }
        // Fallback: the one-minute load spread over the cores. Coarse, but
        // still a real figure from the host rather than an invention.
        _ => load_average
            .map(|load| (load[0] / f64::from(cores) * 100.0).clamp(0.0, 100.0))
            .unwrap_or(0.0),
    };

    Ok(HostMetricsPayload {
        collected_at,
        uptime_seconds: uptime as u64,
        cpu: CpuPayload {
            usage_percent: usage_percent.clamp(0.0, 100.0),
            cores,
            model,
            load_average,
        },
        memory,
        swap,
        disks: parse_disks(section(output, "===DF").unwrap_or("")),
    })
}

/// Reads the resources behind a registered session.
pub async fn collect_for_session(
    registry: &SshRegistry,
    session_id: &str,
) -> Result<HostMetricsPayload, String> {
    let handle = registry
        .session_handle(session_id)
        .ok_or_else(|| format!("no session called '{session_id}'"))?;
    collect(handle).await
}

/// Runs the probe on its own channel of an existing session.
pub(crate) async fn collect(
    session: Arc<client::Handle<TrustingHandler>>,
) -> Result<HostMetricsPayload, String> {
    let probe = async {
        let channel = session
            .channel_open_session()
            .await
            .map_err(|error| format!("could not open a channel: {error}"))?;

        let (mut reader, writer) = channel.split();
        let closing = crate::ssh::ChannelCloseGuard::new(writer);
        closing
            .writer()
            .exec(true, PROBE)
            .await
            .map_err(|error| format!("could not run the probe: {error}"))?;

        let mut output = Vec::new();
        loop {
            match reader.wait().await {
                Some(ChannelMsg::Data { ref data }) => {
                    if output.len() + data.len() > MAX_PROBE_OUTPUT {
                        return Err("the host sent more output than a metrics probe can produce"
                            .to_string());
                    }
                    output.extend_from_slice(data);
                }
                // Standard error is deliberately dropped: every probe command
                // already redirects it, and mixing stray shell noise into the
                // parse would only corrupt sections.
                Some(ChannelMsg::ExtendedData { .. }) => {}
                Some(ChannelMsg::Eof) | Some(ChannelMsg::ExitStatus { .. }) | None => break,
                Some(_) => {}
            }
        }

        parse_metrics(&String::from_utf8_lossy(&output), now_millis())
    };

    tokio::time::timeout(PROBE_TIMEOUT, probe)
        .await
        .map_err(|_| "the host did not answer the metrics probe in time".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINUX_OUTPUT: &str = "\
===UPTIME
123456.78 543210.11
===LOAD
0.52 0.61 0.70 2/345 6789
===CORES
4
===MODEL
Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz
===STAT1
cpu  1000 50 500 8000 450 0 25 0 0 0
===STAT2
cpu  1100 55 550 8800 470 0 30 0 0 0
===MEMINFO
MemTotal:       16384000 kB
MemFree:         2048000 kB
MemAvailable:    8192000 kB
SwapTotal:       4096000 kB
SwapFree:        4000000 kB
===DF
Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda1        102400000  51200000  51200000      50% /
/dev/sdb1        512000000 460800000  51200000      90% /data
tmpfs              8192000         0   8192000       0% /dev/shm
overlay          102400000  51200000  51200000      50% /var/lib/docker/overlay2/x
";

    #[test]
    fn a_full_linux_answer_is_parsed_into_every_reading() {
        let metrics = parse_metrics(LINUX_OUTPUT, 1234).unwrap();

        assert_eq!(metrics.collected_at, 1234);
        assert_eq!(metrics.uptime_seconds, 123456);
        assert_eq!(metrics.cpu.cores, 4);
        assert_eq!(metrics.cpu.load_average, Some([0.52, 0.61, 0.70]));
        assert!(metrics.cpu.model.as_deref().unwrap().contains("Xeon"));

        // Between the samples: busy went 1575→1735 (+160), total 10025→11005
        // (+980), so usage is 160/980 ≈ 16.3%.
        assert!((metrics.cpu.usage_percent - 16.326).abs() < 0.1);

        assert_eq!(metrics.memory.total_bytes, 16384000 * 1024);
        assert_eq!(metrics.memory.used_bytes, (16384000 - 8192000) * 1024);

        let swap = metrics.swap.unwrap();
        assert_eq!(swap.total_bytes, 4096000 * 1024);
        assert_eq!(swap.used_bytes, 96000 * 1024);

        // tmpfs is skipped; the two real devices survive.
        assert_eq!(metrics.disks.len(), 2);
        assert_eq!(metrics.disks[0].mountpoint, "/");
        assert_eq!(metrics.disks[1].mountpoint, "/data");
        assert_eq!(metrics.disks[1].used_bytes, 460800000 * 1024);
    }

    #[test]
    fn a_host_without_proc_is_refused_not_guessed() {
        let error = parse_metrics("command not found\n", 0).unwrap_err();
        assert!(error.contains("Linux"));
    }

    #[test]
    fn missing_stat_samples_fall_back_to_the_load_average() {
        let output = "\
===UPTIME
100.0 200.0
===LOAD
2.0 1.0 0.5 1/2 3
===CORES
4
===MEMINFO
MemTotal: 1000 kB
MemAvailable: 400 kB
";
        let metrics = parse_metrics(output, 0).unwrap();
        // load 2.0 across 4 cores → 50%.
        assert!((metrics.cpu.usage_percent - 50.0).abs() < f64::EPSILON);
    }

    #[test]
    fn the_wire_format_uses_the_field_names_the_interface_reads() {
        let metrics = parse_metrics(LINUX_OUTPUT, 99).unwrap();
        let encoded = serde_json::to_value(&metrics).unwrap();

        assert_eq!(encoded["collectedAt"], 99);
        assert!(encoded["uptimeSeconds"].is_number());
        assert!(encoded["cpu"]["usagePercent"].is_number());
        assert!(encoded["cpu"]["loadAverage"].is_array());
        assert!(encoded["memory"]["totalBytes"].is_number());
        assert!(encoded["disks"][0]["usedBytes"].is_number());
        assert!(encoded.get("collected_at").is_none());
    }

    #[test]
    fn mountpoints_with_spaces_survive_parsing() {
        let output = "\
===UPTIME
1.0 1.0
===MEMINFO
MemTotal: 1000 kB
MemAvailable: 500 kB
===DF
Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/sdc1 1000 500 500 50% /mnt/backup drive
";
        let metrics = parse_metrics(output, 0).unwrap();
        assert_eq!(metrics.disks[0].mountpoint, "/mnt/backup drive");
    }
}
