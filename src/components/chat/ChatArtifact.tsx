import { artifactDocument } from "../../app/artifactDocument";
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChatMarkdown } from "./ChatMarkdown";
import { useI18n } from "../../i18n/context";
interface Artifact { name: string; kind: "html" | "svg" | "markdown" | "image" | "pdf" | "text"; content: string }
export function ChatArtifact({ directory, path, threadId, onClose }: { directory: string; path: string; threadId?: string; onClose: () => void }) {
  const { t } = useI18n(); const [artifact, setArtifact] = useState<Artifact | null>(null); const [error, setError] = useState("");
  useEffect(() => { let active = true; setArtifact(null); setError(""); void invoke<Artifact>("chat_artifact_read", { workingDirectory: directory, path, threadId: threadId ?? null }).then(value => { if (active) setArtifact(value); }).catch(reason => { if (active) setError(String(reason)); }); return () => { active = false; }; }, [directory, path, threadId]);
  // No scripts, navigation, forms, downloads, network, storage, or native IPC.
  const document = useMemo(() => artifact && (artifact.kind === "html" || artifact.kind === "svg") ? artifactDocument(artifact.content) : "", [artifact]);
  return <section className="chat-artifact" role="dialog" aria-label={t("chat.artifact.title")} tabIndex={-1} onKeyDown={event => { if (event.key === "Escape") onClose(); }}>
    <header><strong>{artifact?.name ?? path}</strong><button className="button button--ghost button--sm" onClick={onClose}>{t("chat.artifact.close")}</button></header>
    {error && <p role="alert">{error}</p>}
    {!artifact && !error && <p role="status">{t("chat.artifact.loading")}</p>}
    {artifact && <div className="chat-artifact__body">{artifact.kind === "html" || artifact.kind === "svg" ? <iframe title={artifact.name} sandbox="" srcDoc={document!} referrerPolicy="no-referrer" /> : artifact.kind === "image" ? <img src={artifact.content} alt={artifact.name} /> : artifact.kind === "pdf" ? <iframe title={artifact.name} sandbox="" src={artifact.content} referrerPolicy="no-referrer" /> : artifact.kind === "markdown" ? <ChatMarkdown source={artifact.content} /> : <pre>{artifact.content}</pre>}</div>}
  </section>;
}
