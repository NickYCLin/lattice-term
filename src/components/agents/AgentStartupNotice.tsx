import { useI18n } from "../../i18n/context";
import { Callout } from "../common/Callout";

export function AgentStartupNotice({ unconfirmed, onDismiss }: { unconfirmed?: boolean; onDismiss?: () => void }) {
  const { t } = useI18n();
  if (!unconfirmed) return null;
  return (
    <div className="agent-startup-notice" role="status">
      <Callout tone="warn" title={t("terminal.startupInput.unconfirmedTitle")}
        actions={onDismiss && <button type="button" className="button button--ghost button--sm" onClick={onDismiss}>
          {t("common.close")}</button>}>
        {t("terminal.startupInput.unconfirmedBody")}
      </Callout>
    </div>
  );
}
