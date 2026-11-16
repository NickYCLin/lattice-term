import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/context";
import { hasDesktopBackend } from "../../app/nativeRuntime";

export function OpenEditorButton({ directory }: { directory: string }) {
  return <EditorAction key={directory} directory={directory} />;
}
function EditorAction({ directory }: { directory: string }) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const lock = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function open() {
    if (lock.current || !directory || !hasDesktopBackend()) return;
    lock.current = true; setPending(true); setMessage(""); setFailed(false);
    try {
      await invoke("chat_open_editor", { workingDirectory: directory });
      if (alive.current) setMessage(t("chat.editor.requested"));
    } catch (reason) {
      if (!alive.current) return;
      const code = String(reason);
      setFailed(true);
      setMessage(t(code === "chat.editor.unavailable" ? "chat.editor.unavailable"
        : code === "chat.editor.invalidDirectory" ? "chat.editor.invalidDirectory"
          : code === "chat.editor.unsupported" ? "chat.editor.unsupported" : "chat.editor.failed"));
    } finally { if (alive.current) { lock.current = false; setPending(false); } }
  }
  return <span className="chat-editor-action">
    <button type="button" className="button button--ghost button--sm" disabled={pending || !directory || !hasDesktopBackend()}
      onClick={() => { void open(); }} title={t("chat.editor.hint")}>{t(pending ? "common.loading" : "chat.editor.open")}</button>
    {message && <small role={failed ? "alert" : "status"}>{message}</small>}
  </span>;
}
