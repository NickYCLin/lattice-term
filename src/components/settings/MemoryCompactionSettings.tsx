import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../i18n/context";
import { useChatAccountProfiles } from "../../app/useChatAccountProfiles";
import {
  compactionSettings,
  saveCompactionSettings,
  type CompactionSettings,
  type ContextReport,
} from "../../app/memoryCompaction";
import { hasDesktopBackend } from "../../app/nativeRuntime";
import { memoryError } from "../chat/ProjectMemoryPanel";
import { ContextDetails } from "../chat/CompactionNotice";
export function MemoryCompactionSettings() {
  const { t } = useI18n();
  const profiles = useChatAccountProfiles().filter(
    (profile) => profile.definitionId === "claude",
  );
  const [value, setValue] = useState<CompactionSettings | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [history, setHistory] = useState<ContextReport[]>([]);
  useEffect(() => {
    if (!hasDesktopBackend()) return;
    let gone = false;
    void compactionSettings()
      .then((next) => {
        if (!gone) setValue(next);
      })
      .catch((reason) => {
        if (!gone) setError(String(reason));
      });
    return () => {
      gone = true;
    };
  }, []);
  return (
    <section className="panel glass">
      <header className="panel__head">
        <h2 className="panel__title">{t("memory.compactTitle")}</h2>
      </header>
      <p>{t("memory.compactHint")}</p>
      {error && <p role="alert">{t(memoryError(error))}</p>}
      {value && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            void saveCompactionSettings(value)
              .then(setValue)
              .catch((reason) => setError(String(reason)))
              .finally(() => setBusy(false));
          }}
        >
          <fieldset
            disabled={busy}
            className="setting-list setting-list--form memory-compaction-settings"
          >
            <label className="field">
              {t("memory.limit")}
              <input
                className="input"
                type="number"
                min={2048}
                max={16384}
                step={1024}
                value={value.preferences.limitBytes}
                onChange={(event) =>
                  setValue({
                    ...value,
                    preferences: {
                      ...value.preferences,
                      limitBytes: Number(event.target.value),
                    },
                  })
                }
              />
            </label>
            <label className="field">
              {t("memory.keepVersions")}
              <input
                className="input"
                type="number"
                min={2}
                max={100}
                value={value.preferences.keepVersions}
                onChange={(event) =>
                  setValue({
                    ...value,
                    preferences: {
                      ...value.preferences,
                      keepVersions: Number(event.target.value),
                    },
                  })
                }
              />
            </label>
            <label className="field">
              {t("memory.staleDays")}
              <input
                className="input"
                type="number"
                min={1}
                max={3650}
                value={value.preferences.staleDays}
                onChange={(event) =>
                  setValue({
                    ...value,
                    preferences: {
                      ...value.preferences,
                      staleDays: Number(event.target.value),
                    },
                  })
                }
              />
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={value.preferences.aiEnabled}
                onChange={(event) =>
                  setValue({
                    ...value,
                    preferences: {
                      ...value.preferences,
                      aiEnabled: event.target.checked,
                    },
                  })
                }
              />
              {t("memory.aiEnabled")}
            </label>
            <label className="field">
              {t("memory.aiCli")}
              <select
                className="select"
                value={value.preferences.configDirectory ?? ""}
                onChange={(event) =>
                  setValue({
                    ...value,
                    preferences: {
                      ...value.preferences,
                      configDirectory: event.target.value || null,
                    },
                  })
                }
              >
                <option value="">{t("memory.claudeDefault")}</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.configDirectory}>
                    {profile.name} · Claude Code
                  </option>
                ))}
              </select>
            </label>
            <p className="field__optional">{t("memory.aiHint")}</p>
            <button className="button button--primary" type="submit">
              {t("chat.instructions.save")}
            </button>
          </fieldset>
        </form>
      )}
      <details
        onToggle={(event) => {
          if (
            event.target === event.currentTarget &&
            event.currentTarget.open
          ) {
            void invoke<ContextReport[]>("memory_context_history")
              .then(setHistory)
              .catch((reason) => setError(String(reason)));
          }
        }}
      >
        <summary>{t("memory.contextHistory")}</summary>
        {history.map((report) => (
          <ContextDetails key={report.id} report={report} />
        ))}
      </details>
    </section>
  );
}
