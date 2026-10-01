import { useState, useSyncExternalStore } from "react";
import { desktopChatAccess as access } from "../../app/desktopChat";
import type { ChatThread } from "../../app/agentChat";
import { useI18n } from "../../i18n/context";

const subscribe = (listener: () => void) => { access.listeners.add(listener); return () => { access.listeners.delete(listener); }; };
const snapshot = () => access.revision;
export function ChatMcpAccess({ thread }: { thread: ChatThread }) {
  const { t } = useI18n();
  useSyncExternalStore(subscribe, snapshot, () => 0);
  const [error, setError] = useState<string | null>(null);
  const grant = access.grants.get(thread.id);
  async function change(read: boolean, control: boolean) {
    setError(null);
    try { await access.share(thread, read, control); }
    catch { setError(t("chat.mcpAccess.failed")); }
  }
  return <fieldset className="chat-mcp-access" disabled={!access.nonce || access.pending.has(thread.id)}>
    <legend>{t("chat.mcpAccess.title")}</legend>
    <label><input type="checkbox" checked={grant?.read ?? false} onChange={event => { void change(event.target.checked, grant?.control ?? false); }} />{t("chat.mcpAccess.read")}</label>{" "}
    <label><input type="checkbox" checked={grant?.control ?? false} onChange={event => { void change(grant?.read ?? false, event.target.checked); }} />{t("chat.mcpAccess.control")}</label>
    <p className="field__hint">{t("chat.mcpAccess.hint")}</p>
    {error && <p role="alert">{error}</p>}
  </fieldset>;
}
