import { useI18n } from "../../i18n/context";
import { CloseIcon } from "../icons";
import type { ContextUsage, RateLimitWindow } from "../../app/chatRuntimeStatus";
export function ChatStatus({ model, directory, state, context, rateLimits, onClose }: {
  model: string; directory: string; state: string; context?: ContextUsage | null;
  rateLimits?: readonly RateLimitWindow[]; onClose: () => void;
}) {
  const { t } = useI18n();
  return <section className="chat-status" role="region" aria-label={t("chat.command.status")}>
    <header><strong>{t("chat.command.status")}</strong><button type="button" className="icon-button" onClick={onClose} aria-label={t("common.close")}><CloseIcon /></button></header>
    <dl>
      <dt>{t("chat.model")}</dt><dd>{model || t("chat.model.default")}</dd>
      <dt>{t("chat.directory")}</dt><dd>{directory || t("chat.directory.none")}</dd>
      <dt>{t("chat.status.state")}</dt><dd>{state}</dd>
      <dt>{t("chat.status.context")}</dt><dd>{context ? <>
        {context.tokensUsed.toLocaleString()} / {context.contextWindow?.toLocaleString() ?? t("chat.status.limitNotReported")}
        {context.contextWindow && <progress max={context.contextWindow} value={Math.min(context.tokensUsed, context.contextWindow)} aria-label={t("chat.status.context")} />}
      </> : t("chat.status.notReported")}</dd>
      <dt>{t("chat.status.quota")}</dt><dd>{rateLimits?.length ? rateLimits.map((window, index) => <div key={index}>
        {window.label}{window.windowMinutes ? ` · ${t("chat.status.window", { minutes: window.windowMinutes })}` : ""} · {t("chat.status.used", { percent: Math.round(window.usedPercent) })}
        <progress max={100} value={window.usedPercent} aria-label={window.label} />
        {window.resetsAt !== null && <small>{t("chat.status.resets", { time: new Date(window.resetsAt * 1000).toLocaleString() })}</small>}
      </div>) : t("chat.status.notReported")}</dd>
    </dl>
  </section>;
}
