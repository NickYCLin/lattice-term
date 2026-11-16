import { maskNativeValue } from "../../app/nativeRecords";
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../i18n/context";
import type { MemoryArchive, MemoryVersion } from "../../app/memoryCompaction";
export function MemoryArchiveHistory({
  history,
  directory,
  busy,
  onRestore,
  compact = false,
}: {
  history: MemoryVersion[];
  directory: string;
  busy: boolean;
  compact?: boolean;
  onRestore: (version: MemoryVersion) => void;
}) {
  const { t } = useI18n();
  const [details, setDetails] = useState<Record<string, MemoryArchive>>({}),
    [failed, setFailed] = useState(false);
  return (
    <section className="memory-history">
      {!compact && <h4>{t("memory.versions")}</h4>}
      {failed && <p role="alert">{t("memory.error")}</p>}
      {history.map((version) => (
        <details
          className="chat-card"
          key={`${version.scope}:${version.id}`}
          onToggle={(event) => {
            if (
              event.target === event.currentTarget &&
              event.currentTarget.open &&
              !details[version.id]
            ) {
              void invoke<MemoryArchive>("project_memory_archive", {
                projectDirectory: directory || null,
                scope: version.scope,
                id: version.id,
              })
                .then((value) =>
                  setDetails((old) => ({
                    ...old,
                    [version.id]: maskNativeValue(value),
                  })),
                )
                .catch(() => setFailed(true));
            }
          }}
        >
          <summary>
            {t(
              version.reason === "auto"
                ? "memory.autoCompactionRecord"
                : "memory.restored",
            )}{" "}
            ·{" "}
            {t(version.scope === "project" ? "memory.project" : "memory.user")}{" "}
            · {new Date(version.createdAt).toLocaleString()}
          </summary>
          {details[version.id] && (
            <>
              <div className="memory-comparison">
                <label>
                  {t("memory.before")}
                  <pre className="chat-card__output">
                    {details[version.id].beforeText}
                  </pre>
                </label>
                <label>
                  {t("memory.after")}
                  <pre className="chat-card__output">
                    {details[version.id].afterText ||
                      t("memory.incompleteAttempt")}
                  </pre>
                </label>
              </div>
              {details[version.id].warnings.length > 0 && (
                <p role="status">{t("memory.compactWarning")}</p>
              )}
            </>
          )}
          <p>{t("memory.restoreHint")}</p>
          <button
            className="button button--sm"
            type="button"
            disabled={busy}
            onClick={() => onRestore(version)}
          >
            {t("memory.restoreVersion")}
          </button>
        </details>
      ))}
    </section>
  );
}
