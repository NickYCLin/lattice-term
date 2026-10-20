import { useId } from "react";
import { useI18n } from "../../i18n/context";
import { sessionPermissions, supportsSessionPermissions, type SessionPermission } from "../../app/sessionPermissions";

export function SessionPermissionField({ definitionId, value, onChange, disabled = false }: {
  definitionId: string;
  value: SessionPermission;
  onChange: (value: SessionPermission) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const id = useId();
  if (!supportsSessionPermissions(definitionId)) return null;
  return <div className="field">
    <label className="field__label" htmlFor={id}>{t("chat.permission")}</label>
    <select id={id} className="input" value={value} disabled={disabled}
      aria-describedby={`${id}-hint`}
      onChange={event => {
        const next = event.currentTarget.value as SessionPermission;
        if (sessionPermissions.includes(next)) onChange(next);
      }}>
      {sessionPermissions.map(permission => <option key={permission} value={permission}>
        {t(permission === "default" ? "terminal.permission.default" : `chat.permission.${permission}`)}
      </option>)}
    </select>
    <p id={`${id}-hint`} className="field__hint">{t(value === "full"
      ? "terminal.permission.fullHint" : "terminal.permission.hint")}</p>
  </div>;
}
