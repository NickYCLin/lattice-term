import { useEffect, useState } from "react";
import type { ChatDefinitionId } from "../../app/agentChat";
import { displayPath } from "../../app/displayPath";
import { hasDesktopBackend } from "../../app/nativeRuntime";
import { useI18n } from "../../i18n/context";
import { SharedAgentRulesPanel } from "../agents/SharedAgentRulesPanel";

export interface InstructionFile {
  scope: "user" | "project";
  path: string;
  exists: boolean;
  bytes: number;
  content: string;
  truncated: boolean;
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
              {t(file.scope === "user" ? "chat.instructions.user" : "chat.instructions.project")}
            </span>
            <code className="chat-card__summary" title={file.path}>
              {displayPath(file.path)}
            </code>
          </summary>
          <pre className="chat-card__output">{file.content}</pre>
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
