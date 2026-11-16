import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/context";
import type { MessageKey } from "../../i18n/messages/zh-TW";
import {
  inspectMemory,
  memoryDraft,
  mutateMemory,
  previewMemory,
  MEMORY_CHANGED,
  memoryBytes,
  type MemoryAction,
  type MemoryDraft,
  type MemoryImport,
  type MemorySnapshot,
} from "../../app/projectMemory";
import { maskNativeText } from "../../app/nativeRecords";

export function memoryError(reason: unknown): MessageKey {
  const key =
    String(reason) === "memory.content"
      ? "memory.invalidContent"
      : String(reason);
  return (memoryErrors.has(key) ? key : "memory.error") as MessageKey;
}
const memoryErrors = new Set([
  "memory.conflict",
  "memory.secret",
  "memory.outputLimit",
  "memory.capacity",
  "memory.path",
  "memory.write",
  "memory.read",
  "memory.format",
  "memory.projectRequired",
  "memory.storageConflict",
  "memory.confirmIgnore",
  "memory.manualReview",
  "memory.importSkipped",
  "memory.override",
  "memory.grokReview",
  "memory.invalidContent",
  "memory.duplicate",
  "memory.missing",
  "memory.selection",
]);

export function MemoryEditor({
  value,
  onChange,
  directory,
  disabled,
}: {
  value: MemoryDraft;
  onChange: (value: MemoryDraft) => void;
  directory: string;
  disabled: boolean;
}) {
  const { t } = useI18n();
  return (
    <fieldset disabled={disabled} className="memory-editor">
      <label>
        {t("memory.scope")}
        <select
          className="select"
          value={value.scope}
          disabled={!!value.id}
          onChange={(event) =>
            onChange({
              ...value,
              scope: event.target.value as MemoryDraft["scope"],
            })
          }
        >
          <option value="project" disabled={!directory}>
            {t("memory.project")}
          </option>
          <option value="user">{t("memory.user")}</option>
        </select>
      </label>
      <label>
        {t("memory.type")}
        <select
          className="select"
          value={value.kind}
          onChange={(event) =>
            onChange({
              ...value,
              kind: event.target.value as MemoryDraft["kind"],
            })
          }
        >
          {(["user", "feedback", "project", "reference"] as const).map(
            (kind) => (
              <option key={kind} value={kind}>
                {t(`memory.kind.${kind}`)}
              </option>
            ),
          )}
        </select>
      </label>
      <label className="memory-editor__content">
        {t("memory.content")}
        <textarea
          className="input"
          rows={5}
          value={value.content}
          onChange={(event) =>
            onChange({ ...value, content: event.target.value })
          }
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={value.pinned}
          onChange={(event) =>
            onChange({ ...value, pinned: event.target.checked })
          }
        />
        {t("memory.pinned")}
      </label>
      <span>{memoryBytes(value.content)} / 8192 bytes</span>
      {maskNativeText(value.content) !== value.content ||
      value.content.includes("[REDACTED]") ? (
        <p role="alert">{t("memory.secret")}</p>
      ) : null}
    </fieldset>
  );
}
export function ProjectMemoryPanel({
  directory,
  definitionId,
  configDirectory,
}: {
  directory: string;
  definitionId: string;
  configDirectory: string | null;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false),
    [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<MemoryDraft | null>(null),
    [ignore, setIgnore] = useState(false),
    [preview, setPreview] = useState<MemoryImport | null>(null),
    [selected, setSelected] = useState<string[]>([]);
  const [importScope, setImportScope] = useState<"project" | "user">(
    directory ? "project" : "user",
  );
  const [vendor, setVendor] = useState(
    ["claude", "codex", "gemini", "qwen"].includes(definitionId)
      ? definitionId
      : "claude",
  );
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setSnapshot(null);
    setDraft(null);
    setPreview(null);
    setSelected([]);
    setIgnore(false);
    setError("");
    setBusy(false);
    setImportScope(directory ? "project" : "user");
    if (!open) return;
    const load = () => {
      void inspectMemory(directory)
        .then((value) => {
          if (generation.current === current) setSnapshot(value);
        })
        .catch((reason) => {
          if (generation.current === current) setError(String(reason));
        });
    };
    load();
    window.addEventListener(MEMORY_CHANGED, load);
    return () => {
      ++generation.current;
      window.removeEventListener(MEMORY_CHANGED, load);
    };
  }, [directory, open, definitionId, configDirectory]);
  async function run(action: MemoryAction) {
    if (!snapshot || busy) return false;
    const current = generation.current;
    setBusy(true);
    setError("");
    try {
      const next = await mutateMemory(directory, snapshot.revision, action);
      if (current === generation.current) {
        setSnapshot(next);
        return true;
      }
    } catch (reason) {
      if (current === generation.current) setError(String(reason));
    } finally {
      if (current === generation.current) setBusy(false);
    }
    return false;
  }
  return (
    <details
      className="project-memory"
      onToggle={(event) => {
        if (event.target === event.currentTarget)
          setOpen(event.currentTarget.open);
      }}
    >
      <summary>{t("memory.title")}</summary>
      {open && (
        <>
          <p className="chat-settings__hint">{t("memory.hint")}</p>
          {error && <p role="alert">{t(memoryError(error))}</p>}
          {!snapshot ? (
            <p role="status">{t("common.loading")}</p>
          ) : (
            <>
              <p>
                {t("memory.size", {
                  current: snapshot.outputBytes,
                  max: snapshot.maxOutputBytes,
                })}
              </p>
              {snapshot.warnings.map((warning, index) => (
                <p role="alert" key={index}>
                  {t(memoryError(warning))}
                </p>
              ))}
              <button
                className="button button--sm"
                disabled={busy}
                onClick={() => {
                  setDraft(memoryDraft(directory));
                  setPreview(null);
                }}
              >
                {t("memory.add")}
              </button>
              <button
                className="button button--sm"
                disabled={busy || !directory}
                onClick={() => void run({ kind: "sync" })}
              >
                {t("memory.sync")}
              </button>
              <button
                className="button button--sm"
                disabled={busy}
                onClick={() => {
                  const current = generation.current;
                  void inspectMemory(directory)
                    .then((value) => {
                      if (current === generation.current) setSnapshot(value);
                    })
                    .catch((reason) => {
                      if (current === generation.current)
                        setError(String(reason));
                    });
                }}
              >
                {t("chat.instructions.reload")}
              </button>
              {snapshot.entries.length === 0 && <p>{t("memory.empty")}</p>}
              <ul className="memory-entries">
                {snapshot.entries.map((entry) => (
                  <li className="chat-card" key={`${entry.scope}:${entry.id}`}>
                    <strong>
                      {t(
                        entry.scope === "project"
                          ? "memory.project"
                          : "memory.user",
                      )}{" "}
                      · {t(`memory.kind.${entry.kind}`)}
                      {entry.pinned ? ` · ${t("memory.pinned")}` : ""}
                    </strong>
                    <p className="memory-content">{entry.content}</p>
                    <small>
                      {t("memory.source")}:{" "}
                      {entry.source.cli ?? t("memory.manual")}{" "}
                      {entry.source.path} {entry.source.conversationId}
                    </small>
                    <p>
                      <small>
                        {t("memory.created")}:{" "}
                        {new Date(entry.createdAt).toLocaleString()} ·{" "}
                        {t("memory.lastUsed")}:{" "}
                        {entry.lastUsedAt
                          ? new Date(entry.lastUsedAt).toLocaleString()
                          : "—"}
                      </small>
                    </p>
                    {entry.blocked && <p role="alert">{t("memory.secret")}</p>}
                    <div className="chat-card__actions">
                      <button
                        className="button button--sm"
                        disabled={busy || entry.blocked}
                        onClick={() =>
                          setDraft({
                            id: entry.id,
                            scope: entry.scope,
                            kind: entry.kind,
                            content: entry.content,
                            source: entry.source,
                            pinned: entry.pinned,
                          })
                        }
                      >
                        {t("chat.instructions.edit")}
                      </button>
                      <button
                        className="button button--sm"
                        disabled={busy || entry.blocked}
                        onClick={() =>
                          void run({
                            kind: "upsert",
                            draft: {
                              id: entry.id,
                              scope: entry.scope,
                              kind: entry.kind,
                              content: entry.content,
                              source: entry.source,
                              pinned: !entry.pinned,
                            },
                          })
                        }
                      >
                        {t(entry.pinned ? "memory.unpin" : "memory.pin")}
                      </button>
                      <button
                        className="button button--sm"
                        disabled={busy}
                        onClick={() =>
                          void run({
                            kind: "delete",
                            id: entry.id,
                            scope: entry.scope,
                          })
                        }
                      >
                        {t("memory.delete")}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              {draft && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run({ kind: "upsert", draft }).then((ok) => {
                      if (ok) setDraft(null);
                    });
                  }}
                >
                  <MemoryEditor
                    directory={directory}
                    value={draft}
                    onChange={setDraft}
                    disabled={busy}
                  />
                  <button
                    className="button button--primary"
                    disabled={
                      busy ||
                      !draft.content.trim() ||
                      memoryBytes(draft.content) > 8192
                    }
                  >
                    {t("chat.instructions.save")}
                  </button>
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() => setDraft(null)}
                  >
                    {t("common.cancel")}
                  </button>
                </form>
              )}
              {directory && (
                <label>
                  {t("memory.storage")}
                  <select
                    className="select"
                    value={snapshot.storage}
                    disabled={busy}
                    onChange={(event) =>
                      void run({
                        kind: "storage",
                        location: event.target.value as "project" | "app",
                      })
                    }
                  >
                    <option value="project">.lattice/memory/</option>
                    <option value="app">{t("memory.appStorage")}</option>
                  </select>
                </label>
              )}
              <p className="chat-settings__hint">{t("memory.storageNote")}</p>
              {directory && (
                <>
                  <button
                    className="button button--sm"
                    disabled={busy}
                    onClick={() => setIgnore(true)}
                  >
                    {t("memory.ignore")}
                  </button>
                  {ignore && (
                    <div role="group" aria-label={t("memory.ignore")}>
                      <p>{t("memory.ignoreConfirm")}</p>
                      <button
                        className="button"
                        disabled={busy}
                        onClick={() =>
                          void run({ kind: "ignore", confirmed: true }).then(
                            (ok) => {
                              if (ok) setIgnore(false);
                            },
                          )
                        }
                      >
                        {t("memory.confirm")}
                      </button>
                      <button
                        className="button"
                        disabled={busy}
                        onClick={() => setIgnore(false)}
                      >
                        {t("common.cancel")}
                      </button>
                    </div>
                  )}
                </>
              )}
              <details>
                <summary>{t("memory.import")}</summary>
                <label>
                  {t("memory.source")}
                  <select
                    className="select"
                    value={vendor}
                    disabled={busy}
                    onChange={(event) => {
                      setVendor(event.target.value);
                      setPreview(null);
                      setSelected([]);
                    }}
                  >
                    {["claude", "codex", "gemini", "qwen"].map((cli) => (
                      <option key={cli}>{cli}</option>
                    ))}
                  </select>
                </label>
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => {
                    const current = generation.current;
                    setBusy(true);
                    setError("");
                    void previewMemory(
                      directory,
                      vendor,
                      vendor === definitionId ? configDirectory : null,
                    )
                      .then((value) => {
                        if (current === generation.current) {
                          setPreview(value);
                          setSelected([]);
                        }
                      })
                      .catch((reason) => {
                        if (current === generation.current)
                          setError(String(reason));
                      })
                      .finally(() => {
                        if (current === generation.current) setBusy(false);
                      });
                  }}
                >
                  {t("memory.preview")}
                </button>
                {preview && (
                  <>
                    <p>{t("memory.importHint")}</p>
                    {preview.warnings.map((warning, i) => (
                      <p key={i}>{t(memoryError(warning))}</p>
                    ))}
                    {preview.candidates.length === 0 && (
                      <p>{t("memory.noCandidates")}</p>
                    )}
                    {preview.candidates.map((item) => (
                      <label
                        key={item.id}
                        className="chat-card memory-candidate"
                      >
                        <input
                          type="checkbox"
                          disabled={busy || item.blocked}
                          checked={selected.includes(item.id)}
                          onChange={(event) =>
                            setSelected((old) =>
                              event.target.checked
                                ? [...old, item.id]
                                : old.filter((id) => id !== item.id),
                            )
                          }
                        />
                        <span className="memory-content">
                          {item.content}
                          <small>
                            {item.source.cli} · {item.source.path}
                          </small>
                          {item.blocked && <span>{t("memory.secret")}</span>}
                        </span>
                      </label>
                    ))}
                    <label>
                      {t("memory.scope")}
                      <select
                        className="select"
                        value={importScope}
                        disabled={busy}
                        onChange={(event) =>
                          setImportScope(
                            event.target.value as "project" | "user",
                          )
                        }
                      >
                        <option value="project" disabled={!directory}>
                          {t("memory.project")}
                        </option>
                        <option value="user">{t("memory.user")}</option>
                      </select>
                    </label>
                    <button
                      className="button button--primary"
                      disabled={busy || !selected.length}
                      onClick={() => {
                        void run({
                          kind: "import",
                          ids: selected,
                          scope: importScope,
                          definitionId: vendor,
                          configDirectory:
                            vendor === definitionId ? configDirectory : null,
                          previewRevision: preview.revision,
                        }).then((ok) => {
                          if (ok) {
                            setPreview(null);
                            setSelected([]);
                          }
                        });
                      }}
                    >
                      {t("memory.importSelected", { count: selected.length })}
                    </button>
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() => {
                        setPreview(null);
                        setSelected([]);
                      }}
                    >
                      {t("common.cancel")}
                    </button>
                  </>
                )}
              </details>
              <ul>
                {snapshot.files.map((file) => (
                  <li key={file.cli}>
                    {file.cli} · {file.fileName} ·{" "}
                    {t(`memory.status.${file.state}`)}
                    {file.reason && `：${t(memoryError(file.reason))}`}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </details>
  );
}
