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
  // Lives in the thread's settings panel with the other per-conversation
  // choices, drawn like them.
  return <fieldset className="chat-mcp-access" disabled={!access.nonce || access.pending.has(thread.id)}>
    <legend className="field__label">{t("chat.mcpAccess.title")}</legend>
    <label className="checkbox">
      <input type="checkbox" checked={grant?.read ?? false} onChange={event => { void change(event.target.checked, grant?.control ?? false); }} />
      <span className="checkbox__box" aria-hidden="true">✓</span>
      <span>{t("chat.mcpAccess.read")}</span>
    </label>
    <label className="checkbox">
      <input type="checkbox" checked={grant?.control ?? false} onChange={event => { void change(grant?.read ?? false, event.target.checked); }} />
      <span className="checkbox__box" aria-hidden="true">✓</span>
      <span>{t("chat.mcpAccess.control")}</span>
    </label>
    <p className="chat-settings__hint">{t("chat.mcpAccess.hint")}</p>
    {error && <p role="alert">{error}</p>}
  </fieldset>;
}
