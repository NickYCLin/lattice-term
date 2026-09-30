import { useState } from "react";
import { nativeConversationKey, useNativeHistory } from "../../app/useNativeConversations";
import { useI18n } from "../../i18n/context";

/** Both pages consume the same read-only index, without manufacturing running sessions. */
export function NativeConversationList() {
  const history = useNativeHistory();
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  if (!history) return null;
  const entries = history.entries.filter(entry => `${entry.title} ${entry.workingDirectory}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <section className="native-history" aria-label={t("history.synced")}>
    <div className="native-history__head"><strong>{t("history.synced")}</strong>
      <button type="button" className="button button--ghost button--sm" disabled={history.busy} onClick={history.refresh}>{t("history.refresh")}</button>
    </div>
    <p className="field__hint">{t("history.readOnlySync")}</p>
    <label><input type="checkbox" checked={history.includeArchived} onChange={event => history.setIncludeArchived(event.target.checked)} /> {t("history.includeArchived")}</label>
    <input className="input" aria-label={t("history.search")} placeholder={t("history.search")} value={query} onChange={event => setQuery(event.target.value)} />
    {history.error && <p role="alert">{t("history.stale")} {history.error}</p>}
    {history.incomplete && <p role="status">{t("history.incomplete")}</p>}
    {history.busy && !history.value && <p role="status">{t("common.loading")}</p>}
    <div className="native-history__entries">
      {entries.map(entry => <button type="button" className="local-history__entry" key={nativeConversationKey(entry)} onClick={() => history.open(entry)}>
        <strong>{entry.title}</strong>
        <small>{entry.definitionId} · {entry.profileId ?? t("history.defaultAccount")} · {entry.archived ? t("history.nativeArchived") : !entry.resumable ? t("history.unavailable") : t("history.stateUnknown")}</small>
        <small title={entry.workingDirectory}>{entry.workingDirectory}</small>
      </button>)}
    </div>
    {history.hasMore && <button type="button" className="button button--ghost button--sm" disabled={history.busy} onClick={history.loadMore}>{t("history.loadOlder")}</button>}
  </section>;
}
