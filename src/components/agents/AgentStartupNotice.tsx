import { useI18n } from "../../i18n/context";
import { Callout } from "../common/Callout";

export function AgentStartupNotice({ unconfirmed }: { unconfirmed?: boolean }) {
  const { t } = useI18n();
  if (!unconfirmed) return null;
  return (
    <div className="agent-startup-notice" role="status">
      <Callout tone="warn" title={t("terminal.startupInput.unconfirmedTitle")}>
        {t("terminal.startupInput.unconfirmedBody")}
      </Callout>
    </div>
  );
}
