import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/context";

export function ConversationReadProgress({ loading, error, onRetry }: {
  loading: boolean;
  error?: string | null;
  onRetry?: () => void;
}) {
  const { t } = useI18n();
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    setSeconds(0);
    if (!loading) return;
    const startedAt = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [loading]);
  if (!loading && !error) return null;
  return <div className="chat-read-progress" aria-busy={loading}>
    {loading && <>
      <div className="chat-read-progress__bar" role="progressbar" aria-label={t("history.reading")} />
      <p role="status">{t("history.reading")}</p>
      <p className="chat-read-progress__elapsed">{t("history.elapsed", { seconds })}</p>
      {seconds >= 8 && <p role="status">{t("history.readSlow")}</p>}
    </>}
    {error && <div role="alert"><p>{t("history.readFailed")}</p><p className="session-chat__diagnostic">{error}</p></div>}
    {onRetry && error && <button type="button" className="button button--ghost button--sm" disabled={loading} onClick={onRetry}>{t("history.retryRead")}</button>}
  </div>;
}
