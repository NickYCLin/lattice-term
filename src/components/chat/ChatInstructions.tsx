import { useEffect, useState } from "react";
import type { ChatDefinitionId } from "../../app/agentChat";
import { displayPath } from "../../app/displayPath";
import { hasDesktopBackend } from "../../app/nativeRuntime";
import { useI18n } from "../../i18n/context";
import { SharedAgentRulesPanel } from "../agents/SharedAgentRulesPanel";

export interface InstructionFile {
  scope: "user" | "project" | "memory";
  path: string;
  exists: boolean;
  bytes: number;
  content: string;
  truncated: boolean;
  revision: string;
  editable: boolean;
}

/** Edits one user-level instruction file in place, guarded by its revision. */
function InstructionEditor({
  file,
  definitionId,
  configDirectory,
  onDone,
}: {
  file: InstructionFile;
  definitionId: ChatDefinitionId;
  configDirectory: string | null;
  onDone: (saved: boolean) => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState(file.content);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <form
      className="chat-instructions__editor"
      onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        setError("");
        void import("@tauri-apps/api/core")
          .then(({ invoke }) =>
            invoke("agent_instruction_save", {
              definitionId,
              configDirectory,
              path: file.path,
              content: text,
              expectedRevision: file.revision,
            }),
          )
          .then(() => onDone(true))
          .catch((reason: unknown) => setError(String(reason)))
          .finally(() => setSaving(false));
      }}
    >
      <textarea
        className="input"
        rows={10}
        value={text}
        maxLength={65536}
        onChange={(event) => setText(event.target.value)}
        disabled={saving}
      />
      {error && <p className="field__error">{error}</p>}
      <div className="chat-card__actions">
        <button type="submit" className="button button--primary button--sm" disabled={saving}>
          {t("chat.instructions.save")}
        </button>
        <button type="button" className="button button--ghost button--sm" onClick={() => onDone(false)}>
          {t("common.cancel")}
        </button>
      </div>
    </form>
  );
}

/**
 * What the CLI will read before this conversation's first word: its
 * user-wide instructions and the project's. Read-only here; the project's
 * shared AGENTS.md can be edited through the same guarded editor Agent
 * Fleet uses.
 */
export function ChatInstructions({
  definitionId,
  workingDirectory,
  configDirectory,
}: {
  definitionId: ChatDefinitionId;
  workingDirectory: string;
  configDirectory: string | null;
}) {
  const { t } = useI18n();
  const [files, setFiles] = useState<InstructionFile[] | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    if (!hasDesktopBackend()) return;
    let cancelled = false;
    setError("");
    void import("@tauri-apps/api/core")
      .then(({ invoke }) =>
        invoke<InstructionFile[]>("agent_instruction_files", {
          definitionId,
          workingDirectory: workingDirectory || null,
          configDirectory,
        }),
      )
      .then((next) => {
        if (!cancelled) setFiles(next);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [definitionId, workingDirectory, configDirectory, revision]);

  const present = files?.filter((file) => file.exists) ?? [];
  const missing = files?.filter((file) => !file.exists) ?? [];

  return (
    <details className="chat-instructions">
      <summary>
        {t("chat.instructions.title")}
        {files && <span className="chat-chip">{present.length}</span>}
      </summary>
      <p className="chat-settings__hint">{t("chat.instructions.hint")}</p>
      {error && <p className="field__error">{error}</p>}
      {present.map((file) => (
        <details className="chat-card chat-instructions__file" key={file.path}>
          <summary>
            <span className="chat-card__label">
              {t(
                file.scope === "user"
                  ? "chat.instructions.user"
                  : file.scope === "memory"
                    ? "chat.instructions.memory"
                    : "chat.instructions.project",
              )}
            </span>
            <code className="chat-card__summary" title={file.path}>
              {displayPath(file.path)}
            </code>
          </summary>
          {editing === file.path ? (
            <InstructionEditor
              file={file}
              definitionId={definitionId}
              configDirectory={configDirectory}
              onDone={(saved) => {
                setEditing(null);
                if (saved) setRevision((current) => current + 1);
              }}
            />
          ) : (
            <>
              <pre className="chat-card__output">{file.content}</pre>
              {file.editable && (
                <button type="button" className="button button--ghost button--sm" onClick={() => setEditing(file.path)}>
                  {t("chat.instructions.edit")}
                </button>
              )}
            </>
          )}
          {file.truncated && (
            <p className="chat-settings__hint">
              {t("chat.instructions.truncated", { kib: Math.ceil(file.bytes / 1024) })}
            </p>
          )}
        </details>
      ))}
      {files && present.length === 0 && (
        <p className="chat-settings__hint">{t("chat.instructions.none")}</p>
      )}
      {missing.length > 0 && (
        <p className="chat-settings__hint chat-instructions__missing">
          {t("chat.instructions.missing")}{" "}
          {missing.map((file) => (
            <code key={file.path} title={file.path}>
              {displayPath(file.path)}
            </code>
          ))}
        </p>
      )}
      {missing
        .filter((file) => file.editable)
        .map((file) =>
          editing === file.path ? (
            <InstructionEditor
              key={file.path}
              file={file}
              definitionId={definitionId}
              configDirectory={configDirectory}
              onDone={(saved) => {
                setEditing(null);
                if (saved) setRevision((current) => current + 1);
              }}
            />
          ) : (
            <button
              key={file.path}
              type="button"
              className="button button--ghost button--sm"
              onClick={() => setEditing(file.path)}
              title={file.path}
            >
              {t("chat.instructions.create", { path: displayPath(file.path) })}
            </button>
          ),
        )}
      <button
        type="button"
        className="button button--ghost button--sm"
        onClick={() => setRevision((current) => current + 1)}
      >
        {t("chat.instructions.reload")}
      </button>
      {workingDirectory && (
        <details className="chat-instructions__edit">
          <summary>{t("chat.instructions.editShared")}</summary>
          <SharedAgentRulesPanel projectDirectory={workingDirectory} disabled={false} />
        </details>
      )}
    </details>
  );
}
