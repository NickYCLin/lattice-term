import type { AgentMcpHistory as History } from "../../app/useAgentDaemon";
import { useI18n } from "../../i18n/context";

export function AgentMcpHistory({ history }: { history: History | null }) {
  const { t, locale } = useI18n();
  return (
    <section className="agents-mcp__history" aria-label={t("agents.mcp.history.title")}>
      <h3 className="field__label">{t("agents.mcp.history.title")}</h3>
      <p className="agents-field-hint">{t("agents.mcp.history.hint")}</p>
      {history && (
        <p role="status" className="agents-field-hint">
          {t(`agents.mcp.history.persistence.${history.persistence ?? "memoryOnly"}`)}
          {history.persistence === "unavailable" && history.persistenceReason && (
            <> {t(`agents.mcp.history.reason.${history.persistenceReason}`)}</>
          )}
        </p>
      )}
      {!history ? (
        <p role="status">{t("agents.mcp.history.unavailable")}</p>
      ) : history.entries.length === 0 ? (
        <p>{t("agents.mcp.history.empty")}</p>
      ) : (
        <>
          {history.discarded > 0 && (
            <p className="agents-field-hint">
              {t("agents.mcp.history.discarded", { count: history.discarded, limit: history.limit })}
            </p>
          )}
          <ol className="agents-mcp__history-list" tabIndex={0}>
            {history.entries.map((entry) => (
              <li key={entry.id}>
                <div className="agents-mcp__history-heading">
                  <strong>{entry.client}</strong>
                  <span>{t(`agents.mcp.history.outcome.${entry.outcome}`)}</span>
                  <time dateTime={new Date(entry.at).toISOString()}>
                    {new Date(entry.at).toLocaleString(locale)}
                  </time>
                </div>
                <span>
                  {t(`agents.mcp.history.action.${entry.action}`)}
                  {entry.repeated && entry.repeated > 1 ? (
                    <> {t("agents.mcp.history.repeated", {
                      count: entry.repeated,
                      since: new Date(entry.firstAt ?? entry.at).toLocaleString(locale),
                    })}</>
                  ) : null}
                </span>
                <span className="mono agents-field-hint">
                  {entry.sessionId ?? entry.targetId ?? t("agents.mcp.history.noSession")}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
