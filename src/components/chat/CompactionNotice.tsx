import {
  MEMORY_CHANGED,
  inspectMemory,
  mutateMemory,
} from "../../app/projectMemory";
import { MemoryArchiveHistory } from "./MemoryArchiveHistory";
import type { MemoryVersion } from "../../app/memoryCompaction";
import { hasDesktopBackend } from "../../app/nativeRuntime";
import { maskNativeValue } from "../../app/nativeRecords";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  COMPACTED,
  type ContextReport,
  type ContextItem,
} from "../../app/memoryCompaction";
import { useI18n } from "../../i18n/context";
import { memoryError } from "./ProjectMemoryPanel";
export function ContextDetails({ report }: { report: ContextReport }) {
  report = maskNativeValue(report);
  const { t } = useI18n();
  const [original, setOriginal] = useState<ContextItem[] | null>(null),
    [error, setError] = useState("");
  return (
    <details className="chat-card memory-compaction-notice">
      <summary>
        {t(
          report.compacted
            ? "memory.autoCompacted"
            : "memory.structuredContext",
        )}{" "}
        · {report.label} · {report.beforeBytes} → {report.afterBytes} bytes
      </summary>
      <p>{report.originalPath}</p>
      {(report.sources?.length??0)>0&&<ul>{report.sources?.map((source,index)=><li key={index}>{source}</li>)}</ul>}
      {report.warnings.map((warning, index) => (
        <p role="status" key={index}>
          {t(memoryError(warning))}
        </p>
      ))}
      <pre className="chat-card__output">{report.text}</pre>
      <button
        type="button"
        className="button button--sm"
        onClick={() => {
          void invoke<ContextItem[]>("memory_context_original", {
            id: report.id,
          })
            .then((value) => setOriginal(maskNativeValue(value)))
            .catch((reason) => setError(String(reason)));
        }}
      >
        {t("memory.compareOriginal")}
      </button>
      {original && (
        <div className="memory-comparison">
          <pre className="chat-card__output">
            {original
              .map((item) => `<${item.role}>\n${item.text}`)
              .join("\n\n")}
          </pre>
          <pre className="chat-card__output">{report.text}</pre>
        </div>
      )}
      {error && <p role="alert">{t(memoryError(error))}</p>}
    </details>
  );
}
export function CompactionNotice() {
  const { t } = useI18n();
  const [report, setReport] = useState<ContextReport | null>(null);
  const [memory, setMemory] = useState<{
    directory: string;
    version: MemoryVersion;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(false);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    if (hasDesktopBackend())
      void import("@tauri-apps/api/event")
        .then(({ listen }) =>
          listen<ContextReport>("memory-auto-compacted", (event) => {
            if (!disposed) {
              setMemory(null);
              setReport(event.payload);
            }
          }),
        )
        .then((stop) => {
          if (disposed) stop();
          else unlisten = stop;
        })
        .catch(() => {});
    const onEvent = (event: Event) => {
      setMemory(null);
      setReport((event as CustomEvent<ContextReport>).detail);
    };
    const onMemory = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          directory: string;
          version: MemoryVersion;
        } | null>
      ).detail;
      if (detail?.version) {
        setReport(null);
        setMemory(detail);
        setError(false);
      }
    };
    window.addEventListener(MEMORY_CHANGED, onMemory);
    window.addEventListener(COMPACTED, onEvent);
    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener(COMPACTED, onEvent);
      window.removeEventListener(MEMORY_CHANGED, onMemory);
    };
  }, []);
  if (report) return <ContextDetails key={report.id} report={report} />;
  return memory ? (
    <div className="memory-compaction-notice">
      {error && <p role="alert">{t("memory.error")}</p>}
      <MemoryArchiveHistory
        compact
        history={[memory.version]}
        directory={memory.directory}
        busy={busy}
        onRestore={(version) => {
          setBusy(true);
          setError(false);
          void inspectMemory(memory.directory)
            .then((current) =>
              mutateMemory(memory.directory, current.revision, {
                kind: "restore",
                id: version.id,
                scope: version.scope,
              }),
            )
            .catch(() => setError(true))
            .finally(() => setBusy(false));
        }}
      />
    </div>
  ) : null;
}
