import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AgentSessionSummary } from "../../app/useAgentSessions";
import { useJevAdvisor } from "../../app/useJevAdvisor";
import { validJevPreview } from "../../app/jevAdvice";
import { useI18n } from "../../i18n/context";
import "./jevAdvisor.css";

export function JevAdvisorPanel({ sessions }: {
  sessions: readonly Pick<AgentSessionSummary, "sessionId" | "groupLabel" | "label" | "model">[];
}) {
  const { t } = useI18n();
  const advisor = useJevAdvisor();
  const [key, setKey] = useState("");
  const [linkError, setLinkError] = useState(false);
  const selectedExists = sessions.some(item => item.sessionId === advisor.sessionId);
  useEffect(() => {
    if (advisor.sessionId && !selectedExists) advisor.select("");
  }, [advisor.sessionId, selectedExists]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="panel glass jev-advisor">
      <h2 className="panel__title">{t("jev.title")}</h2>
      <p className="panel__hint">{t("jev.hint")}</p>
      <details>
        <summary>{t("jev.setup")}</summary>
        <ol>
          <li>{t("jev.setup.login")}</li>
          <li>{t("jev.setup.key")}</li>
          <li>{t("jev.setup.enable")}</li>
        </ol>
        <button type="button" className="button button--ghost button--sm"
          onClick={() => void openUrl("https://console.typesafe.ai").catch(() => setLinkError(true))}>
          {t("jev.console")}
        </button>
        {linkError && <p>https://console.typesafe.ai</p>}
      </details>
      {!advisor.enabled ? (
        <form className="jev-advisor__controls" onSubmit={event => {
          event.preventDefault();
          const value = key.trim();
          setKey("");
          void advisor.configure(value);
        }}>
          <label>{t("jev.key")}
            <input className="input" type="password" value={key} autoComplete="off" spellCheck={false}
              maxLength={512} onChange={event => setKey(event.currentTarget.value)} />
          </label>
          <button type="submit" className="button button--secondary" disabled={advisor.loading || !key.trim()}>
            {t("jev.enable")}
          </button>
        </form>
      ) : (
        <>
          <div className="jev-advisor__controls">
            <span>{t("jev.enabled")}</span>
            <button type="button" className="button button--ghost" disabled={advisor.loading}
              onClick={() => { setKey(""); void advisor.configure(null); }}>{t("jev.disable")}</button>
          </div>
          <label>{t("jev.session")}
            <select className="select" value={advisor.sessionId} disabled={advisor.busy || advisor.loading}
              onChange={event => advisor.select(event.currentTarget.value)}>
              <option value="">{t("jev.choose")}</option>
              {sessions.map(item => <option key={item.sessionId} value={item.sessionId}>
                {[item.groupLabel, item.label, item.model].filter(Boolean).join(" · ")}
              </option>)}
            </select>
          </label>
          <button type="button" className="button button--secondary" disabled={!selectedExists || advisor.busy || advisor.loading}
            onClick={() => void advisor.preview()}>{t("jev.preview")}</button>
          <p className="panel__hint">{t("jev.reviewHint")}</p>
          <label>{t("jev.excerpt")}
            <textarea className="input" rows={8} value={advisor.text} maxLength={8_000}
              disabled={advisor.busy || advisor.loading || !selectedExists}
              onChange={event => advisor.edit(event.currentTarget.value)} />
          </label>
          <label className="jev-advisor__consent">
            <input type="checkbox" checked={advisor.consent} disabled={advisor.busy || advisor.loading || !validJevPreview(advisor.text)}
              onChange={event => advisor.setConsent(event.currentTarget.checked)} />
            {t("jev.consent")}
          </label>
          <button type="button" className="button button--primary"
            disabled={advisor.busy || advisor.loading || !advisor.consent || !selectedExists || !validJevPreview(advisor.text)}
            onClick={() => void advisor.analyze()}>{t(advisor.busy ? "jev.busy" : "jev.analyze")}</button>
          {advisor.result && <div className="jev-advisor__result" role="status">
            <strong>{t(`jev.category.${advisor.result.category}`)}</strong>
            <p>{t("jev.resultHint")}</p>
            {advisor.result.evidence && <blockquote>{advisor.result.evidence}</blockquote>}
            <small>{advisor.result.model} · {t("jev.tokens", { count: advisor.result.inputTokens })}</small>
          </div>}
        </>
      )}
      {advisor.error && <p role="alert">{t(advisor.error)}</p>}
    </section>
  );
}
