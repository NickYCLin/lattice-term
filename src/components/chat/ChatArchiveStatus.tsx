import { useI18n } from "../../i18n/context";
import { Callout } from "../common/Callout";

export function ChatArchiveStatus({ error, pending, receipt, onRetry, onRestore }: {
  error?: string | null;
  pending?: boolean;
  receipt?: { error: string | null; pending: boolean } | null;
  onRetry: () => void;
  onRestore: () => void;
}) {
  const { t } = useI18n();
  return <>
    {error && <Callout tone="danger" title={t("chat.archive.failed")}>
      <p>{error}</p>
      <button type="button" className="button" disabled={pending} onClick={onRetry}>{t("chat.archive.retry")}</button>
    </Callout>}
    {receipt && <Callout tone="info" title={t("chat.archive.done")}>
      {receipt.error && <p role="alert">{receipt.error}</p>}
      <button type="button" className="button" disabled={receipt.pending} onClick={onRestore}>{t("chat.archive.restore")}</button>
    </Callout>}
  </>;
}
