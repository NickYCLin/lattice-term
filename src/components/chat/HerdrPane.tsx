import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSerialNativeRead } from "../../app/useNativeConversations";
import { herdrAgentKey, herdrCanPrompt, type HerdrAgent, type HerdrSnapshot } from "../../app/herdr";
import { useI18n } from "../../i18n/context";
import { ConversationReadProgress } from "./ConversationReadProgress";

export function HerdrPane({ enabled }: { enabled: boolean }) {
  const { t } = useI18n();
  const [sessionInput, setSessionInput] = useState("default");
  const [session, setSession] = useState("default");
  const [selection, setSelection] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const agents = useSerialNativeRead(session, enabled, 10_000,
    () => invoke<HerdrAgent[]>("herdr_agents", { session }));
  const selected = agents.value?.find(agent => herdrAgentKey(agent) === selection) ?? null;
  const draftKey = JSON.stringify([session, selection]);
  const draft = drafts[draftKey] ?? "";
  const read = useSerialNativeRead(draftKey, enabled && selected !== null, 2_000,
    () => invoke<HerdrSnapshot>("herdr_read", { session, target: selected!.pane_id, terminalId: selected!.terminal_id }));
  const canSend = !sending && !agents.error && !read.error && herdrCanPrompt(read.value?.agent ?? null, draft);

  async function send() {
    if (!canSend || !selected || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true); setSendError(null); setSent(false);
    try {
      await invoke("herdr_prompt", { session, target: selected.pane_id, terminalId: selected.terminal_id, text: draft });
      setDrafts(current => ({ ...current, [draftKey]: "" }));
      setSent(true);
      read.refresh(); agents.refresh();
    } catch (error) {
      setSendError(String(error));
    } finally {
      sendingRef.current = false; setSending(false);
    }
  }

  return <section className="herdr-pane" aria-label="Herdr">
    <h2>Herdr</h2>
    <p>{t("herdr.disclosure")}</p>
    {!enabled ? <p role="status">{t("desktopBackend.required.body")}</p> : <>
      <form className="herdr-pane__controls" onSubmit={event => {
        event.preventDefault();
        if (sendingRef.current) return;
        setSession(sessionInput.trim()); setSelection(""); setSendError(null); setSent(false);
        agents.refresh();
      }}>
        <label>{t("herdr.session")}<input value={sessionInput} disabled={sending} maxLength={80}
          pattern="[A-Za-z0-9_-]+" required onChange={event => setSessionInput(event.target.value)} /></label>
        <button className="button" type="submit" disabled={sending}>{t("herdr.connect")}</button>
        <button className="button button--ghost" type="button" disabled={agents.busy} onClick={agents.refresh}>{t("herdr.refresh")}</button>
      </form>
      <ConversationReadProgress loading={agents.busy && agents.value === null} error={agents.error} onRetry={agents.refresh} />
      {agents.value?.length === 0 && <p role="status">{t("herdr.empty")}</p>}
      <label>{t("herdr.agent")}<select value={selected ? selection : ""} disabled={sending} onChange={event => {
        setSelection(event.target.value); setSendError(null); setSent(false);
      }}>
        <option value="">{t("herdr.choose")}</option>
        {(agents.value ?? []).map(agent => <option key={herdrAgentKey(agent)} value={herdrAgentKey(agent)}>
          {agent.title || agent.name || agent.agent || agent.pane_id} · {agent.pane_id} · {agent.agent_status}
        </option>)}
      </select></label>
      {selected && <>
        <p>{selected.agent} · {read.value?.agent.agent_status ?? selected.agent_status} · {selected.cwd}</p>
        <ConversationReadProgress loading={read.busy && read.value === null} error={read.error} onRetry={read.refresh} />
        <pre className="herdr-pane__output" tabIndex={0} aria-label={t("herdr.output")}>{read.value?.text ?? ""}</pre>
        <form className="herdr-pane__composer" onSubmit={event => { event.preventDefault(); void send(); }}>
          <label>{t("herdr.message")}<input value={draft} disabled={sending} onChange={event => {
            setDrafts(current => ({ ...current, [draftKey]: event.target.value })); setSent(false);
          }} /></label>
          <p>{t("herdr.sendHint")}</p>
          <button type="submit" className="button button--primary" disabled={!canSend}>{t(sending ? "herdr.sending" : "herdr.send")}</button>
        </form>
        {sent && <p role="status">{t("herdr.sent")}</p>}
        {sendError && <div role="alert"><p>{sendError}</p><p>{t("herdr.uncertain")}</p></div>}
      </>}
    </>}
  </section>;
}
