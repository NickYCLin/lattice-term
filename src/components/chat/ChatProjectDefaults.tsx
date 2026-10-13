import type { ChatProjectDefaults as ProjectDefaults } from "../../app/chatProjectDefaults";
import type { ChatPermission } from "../../app/agentChat";
import { useI18n } from "../../i18n/context";
import type { MessageKey } from "../../i18n/messages/zh-TW";

const permissionKeys: Record<ChatPermission, MessageKey> = {
  ask: "chat.permission.ask", readOnly: "chat.permission.readOnly",
  workspaceWrite: "chat.permission.workspaceWrite", full: "chat.permission.full",
};

export function ChatProjectDefaults({ defaults, canSave, notice, onSave, onClear }: {
  defaults: ProjectDefaults | null;
  canSave: boolean;
  notice: string | null;
  onSave: () => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  return <details className="chat-project-defaults">
    <summary>{t("chat.projects.defaults")}</summary>
    <p>{t("chat.projects.defaults.hint")}</p>
    <p>{defaults
      ? `${defaults.provider === "cliproxyapi" ? "CLIProxyAPI" : defaults.definitionId} · ${defaults.model || t("chat.model.default")} · ${t(permissionKeys[defaults.permission])}`
      : t("chat.projects.defaults.recent")}</p>
    <button type="button" className="button button--ghost button--sm" disabled={!canSave} onClick={onSave}>
      {t("chat.projects.defaults.save")}
    </button>
    <button type="button" className="button button--ghost button--sm" onClick={onClear}>
      {t("chat.projects.defaults.clear")}
    </button>
    {notice && <p role="status">{notice}</p>}
  </details>;
}
