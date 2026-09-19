import { useCallback, useEffect, useRef, useState } from "react";
import {
  appendBounded,
  cancelFleetTurn,
  launchFleetPlan,
  listFleetPlans,
  listFleetSessions,
  listFleetTargets,
  readFleetOutput,
  sendFleetPrompt,
  type FleetPlan,
  type FleetSession,
  type FleetTarget,
} from "../../app/remoteFleet";
import { hasDesktopBackend } from "../../app/nativeRuntime";
import { useI18n } from "../../i18n/context";
import type { MessageKey } from "../../i18n/messages/zh-TW";
import { RefreshIcon } from "../icons";

const stateKey: Record<string, MessageKey> = {
  working: "agents.state.working",
  idle: "agents.state.idle",
  done: "agents.state.done",
  needsAttention: "agents.state.needsAttention",
};

/**
 * Remote Fleet sessions side by side on the Fleet page: the same workspace
 * an MCP client can reach, through the connection and scopes the user
 * granted in Settings. Output is plain text with terminal controls
 * removed, and is untrusted data from the other machine.
 */
export function RemoteFleetPanel() {
  const { t } = useI18n();
  const [targets, setTargets] = useState<FleetTarget[]>([]);
  const [targetId, setTargetId] = useState("");
  const [sessions, setSessions] = useState<FleetSession[]>([]);
  const [plans, setPlans] = useState<FleetPlan[]>([]);
  const [error, setError] = useState("");
  const [openIds, setOpenIds] = useState<string[]>([]);
  const target = targets.find((entry) => entry.id === targetId) ?? null;

  const loadTargets = useCallback(async () => {
    if (!hasDesktopBackend()) return;
    try {
      const next = await listFleetTargets();
      setTargets(next);
      setTargetId((current) => (next.some((entry) => entry.id === current) ? current : next[0]?.id ?? ""));
    } catch (reason) {
      setError(String(reason));
    }
  }, []);

  const loadSessions = useCallback(async () => {
    if (!targetId) return;
    try {
      setSessions(await listFleetSessions(targetId));
      setError("");
    } catch (reason) {
      setError(String(reason));
    }
  }, [targetId]);

  useEffect(() => {
    void loadTargets();
  }, [loadTargets]);

  useEffect(() => {
    setSessions([]);
    setPlans([]);
    setOpenIds([]);
    if (!targetId) return;
    void loadSessions();
    if (target?.scopes.fleetLaunch) void listFleetPlans(targetId).then(setPlans).catch(() => {});
    const timer = window.setInterval(() => void loadSessions(), 5000);
    return () => window.clearInterval(timer);
  }, [targetId, target?.scopes.fleetLaunch, loadSessions]);

  if (!hasDesktopBackend()) return null;

  return (
    <section className="agents-remote-fleet">
      <div className="agents-section-heading">
        <div>
          <span className="eyebrow">{t("agents.remoteFleet.eyebrow")}</span>
          <h3>{t("agents.remoteFleet.title")}</h3>
          <p>{t("agents.remoteFleet.body")}</p>
        </div>
        <button type="button" className="button button--ghost button--sm" onClick={() => void loadTargets()}>
          <RefreshIcon />
          {t("agents.remoteFleet.refresh")}
        </button>
      </div>
      {targets.length === 0 ? (
        <p className="agents-running__empty">{t("agents.remoteFleet.none")}</p>
      ) : (
        <>
          <label className="field">
            <span className="field__label">{t("agents.remoteFleet.target")}</span>
            <select className="select" value={targetId} onChange={(event) => setTargetId(event.target.value)}>
              {targets.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                  {entry.connected ? "" : ` (${t("agents.remoteFleet.offline")})`}
                </option>
              ))}
            </select>
          </label>
          {error && <p className="field__error">{error}</p>}
          {plans.length > 0 && (
            <div className="agents-remote-fleet__plans">
              {plans.map((plan) => (
                <button
                  key={plan.planId}
                  type="button"
                  className="button button--secondary button--sm"
                  onClick={() =>
                    void launchFleetPlan(targetId, plan.planId)
                      .then(() => loadSessions())
                      .catch((reason: unknown) => setError(String(reason)))
                  }
                >
                  {t("agents.remoteFleet.launch", { label: plan.label })}
                </button>
              ))}
            </div>
          )}
          {sessions.length === 0 ? (
            <p className="agents-running__empty">{t("agents.remoteFleet.noSessions")}</p>
          ) : (
            <ul className="agents-remote-fleet__sessions">
              {sessions.map((session) => (
                <li key={session.sessionId}>
                  <span className={`agent-state-dot state-${session.state}`} aria-hidden="true" />
                  <strong>{session.label}</strong>
                  <span className="chat-chip">{t(stateKey[session.state] ?? "agents.state.idle")}</span>
                  {session.readOutput && (
                    <button
                      type="button"
                      className="button button--ghost button--sm"
                      onClick={() =>
                        setOpenIds((current) =>
                          current.includes(session.sessionId)
                            ? current.filter((id) => id !== session.sessionId)
                            : [...current, session.sessionId].slice(-4),
                        )
                      }
                    >
                      {t(openIds.includes(session.sessionId) ? "agents.remoteFleet.hide" : "agents.remoteFleet.show")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {openIds.length > 0 && (
            <div className="agents-remote-fleet__panes">
              {openIds.map((sessionId) => {
                const session = sessions.find((entry) => entry.sessionId === sessionId);
                return session ? (
                  <RemoteFleetPane
                    key={sessionId}
                    targetId={targetId}
                    session={session}
                    canControl={session.access === "control" && target?.scopes.fleetControl === true}
                  />
                ) : null;
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function RemoteFleetPane({
  targetId,
  session,
  canControl,
}: {
  targetId: string;
  session: FleetSession;
  canControl: boolean;
}) {
  const { t } = useI18n();
  const [output, setOutput] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const cursor = useRef(0);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      try {
        // Drain what is there, a few pages at a time, then wait.
        for (let page = 0; page < 8 && !cancelled; page += 1) {
          const next = await readFleetOutput(targetId, session.sessionId, cursor.current);
          cursor.current = next.nextCursor;
          if (next.text) setOutput((current) => appendBounded(current, next.text));
          if (!next.hasMore) break;
        }
        if (!cancelled) setError("");
      } catch (reason) {
        if (!cancelled) setError(String(reason));
      }
      if (!cancelled) timer = window.setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [targetId, session.sessionId]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [output]);

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="agents-remote-fleet__pane">
      <header>
        <strong>{session.label}</strong>
        <span className="chat-chip">{t(stateKey[session.state] ?? "agents.state.idle")}</span>
        {canControl && (
          <button
            type="button"
            className="button button--ghost button--sm"
            disabled={busy}
            onClick={() => void act(() => cancelFleetTurn(targetId, session.sessionId))}
          >
            {t("agents.remoteFleet.cancel")}
          </button>
        )}
      </header>
      <pre ref={logRef} className="agents-remote-fleet__log">
        {output || t("agents.remoteFleet.waiting")}
      </pre>
      {error && <p className="field__error">{error}</p>}
      {canControl && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const text = prompt.trim();
            if (!text) return;
            void act(async () => {
              await sendFleetPrompt(targetId, session.sessionId, text);
              setPrompt("");
            });
          }}
        >
          <input
            className="input"
            value={prompt}
            maxLength={16000}
            placeholder={t("agents.remoteFleet.promptPlaceholder")}
            onChange={(event) => setPrompt(event.target.value)}
            disabled={busy}
          />
          <button type="submit" className="button button--primary button--sm" disabled={busy || !prompt.trim()}>
            {t("agents.remoteFleet.send")}
          </button>
        </form>
      )}
    </article>
  );
}
