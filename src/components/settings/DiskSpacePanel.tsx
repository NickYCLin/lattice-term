import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { formatBytes } from "../../domain/metrics";
import { useI18n } from "../../i18n/context";

interface Item {
  path: string;
  bytes: number;
  compressed: boolean;
  stored: number | null;
}

interface DiskUsage {
  profiles: number;
  chats: number;
  webview: number;
  partial: boolean;
  attachments: Item[];
  history: Item[];
}

export function DiskSpacePanel() {
  const { t, tag } = useI18n();
  const [usage, setUsage] = useState<DiskUsage>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [limits, setLimits] = useState({ attachments: 20, history: 20 });

  async function run(command?: string, args?: Record<string, unknown>) {
    setBusy(true);
    setNotice("");
    try {
      if (command) await invoke(command, args);
      if (command !== "disk_reveal_attachment") setUsage(await invoke<DiskUsage>("disk_usage"));
      if (command === "disk_clear_cache") setNotice(t("disk.cleared"));
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  return <section className="panel glass glass--sheen">
    <header className="panel__head">
      <h2 className="panel__title">{t("disk.title")}</h2>
      <button type="button" className="btn" disabled={busy} onClick={() => void run()}>{t(busy ? "disk.busy" : "disk.scan")}</button>
    </header>
    {usage && <>
      <dl className="field-list">{(["profiles", "chats", "webview"] as const).map(key =>
        <div className="field-row" key={key}>
          <dt className="field-row__label">{t(`disk.${key}`)}</dt>
          <dd className="field-row__value">{formatBytes(usage[key], tag)}</dd>
        </div>
      )}</dl>
      {usage.partial && <p role="status">{t("disk.partial")}</p>}
      <button type="button" className="btn" disabled={busy} onClick={() => void run("disk_clear_cache")}>{t("disk.clear")}</button>
      {(["attachments", "history"] as const).map(group => <details key={group}>
        <summary>{t(`disk.${group}`)} ({usage[group].length})</summary>
        <p className="panel__hint">{t(group === "attachments" ? "disk.imagesHint" : "disk.historyHint")}</p>
        {usage[group].slice(0, limits[group]).map(item => <div className="setting" key={item.path}>
          <div className="setting__text"><span style={{ overflowWrap: "anywhere" }}>{item.path}</span><small> · {formatBytes(item.bytes, tag)}{item.stored != null && t("disk.stored", { size: formatBytes(item.stored, tag) })}</small></div>
          <button type="button" className="btn" disabled={busy} onClick={() => void (group === "attachments"
            ? run("disk_reveal_attachment", { path: item.path })
            : run("disk_compress_history", { path: item.path, compress: !item.compressed }))}>
            {t(group === "attachments" ? "disk.reveal" : item.compressed ? "disk.restore" : "disk.compress")}
          </button>
        </div>)}
        {limits[group] < usage[group].length && <button type="button" className="btn" onClick={() => setLimits(prev => ({ ...prev, [group]: prev[group] + 20 }))}>{t("disk.more")}</button>}
      </details>)}
    </>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
