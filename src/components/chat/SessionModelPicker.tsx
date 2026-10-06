import { useEffect, useRef, useState } from "react";
import { hasChatModels } from "../../app/accountModels";
import type { ChatModelChoice } from "../../app/agentChat";
import { cliProxyIdFromArguments } from "../../app/cliProxyApi";
import { hasDesktopBackend } from "../../app/nativeRuntime";
import { modelSwitchRequest, switchesModelInPlace } from "../../app/sessionModelSwitch";
import type { AgentApi, AgentSessionSummary } from "../../app/useAgentSessions";
import { useCliProxyModels, useCliProxySettings } from "../../app/useCliProxyApi";
import { useI18n } from "../../i18n/context";

type Choices =
  | { state: "idle" | "loading" }
  | { state: "ready"; models: { value: string; label: string }[] }
  | { state: "unavailable"; reason: string };

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * The composer's model name, as a menu that switches the running session to
 * another model while keeping its conversation.
 */
export function SessionModelPicker({ session, agents, disabled, onNotice, onReplaced }: {
  session: AgentSessionSummary;
  agents: AgentApi;
  /** A relaunch would cut off the turn in progress. */
  disabled: boolean;
  onNotice: (text: string | null) => void;
  /** The session resumed on the new model under a new id. */
  onReplaced: (sessionId: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [accountChoices, setAccountChoices] = useState<Choices>({ state: "idle" });
  const menuRef = useRef<HTMLDivElement>(null);
  const proxyId = cliProxyIdFromArguments(session.launchArguments);
  const settings = useCliProxySettings();
  const endpoint = proxyId ? settings.proxies.find(proxy => proxy.id === proxyId) ?? null : null;
  const proxyModels = useCliProxyModels(endpoint, open && proxyId !== null);
  const current = session.model || session.label;

  useEffect(() => {
    if (!open || proxyId !== null || accountChoices.state !== "idle") return;
    if (!hasDesktopBackend() || !hasChatModels(session.definitionId)) {
      setAccountChoices({ state: "unavailable", reason: t("sessionChat.model.none") });
      return;
    }
    setAccountChoices({ state: "loading" });
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<ChatModelChoice[]>("agent_chat_models", {
        definitionId: session.definitionId,
        profileConfigPath: session.profileConfigPath ?? null,
      }))
      .then(models => setAccountChoices({
        state: "ready",
        models: models.map(model => ({ value: model.value, label: model.label || model.value })),
      }))
      .catch(reason => setAccountChoices({ state: "unavailable", reason: errorText(reason) }));
  }, [open, proxyId, accountChoices.state, session.definitionId, session.profileConfigPath, t]);

  useEffect(() => {
    if (!open) return;
    function close(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  const choices: Choices = proxyId === null
    ? accountChoices
    : proxyModels.state === "ready"
      ? { state: "ready", models: proxyModels.models.map(model => ({ value: model.id, label: model.id })) }
      : proxyModels.state === "unavailable"
        ? { state: "unavailable", reason: proxyModels.reason }
        : endpoint
          ? { state: "loading" }
          : { state: "unavailable", reason: t("sessionChat.model.none") };

  async function pick(model: string) {
    setOpen(false);
    if (model === session.model) return;
    onNotice(null);
    setSwitching(true);
    try {
      if (switchesModelInPlace(session)) {
        await agents.enqueue(session.sessionId, `/model ${model}`);
        return;
      }
      const request = modelSwitchRequest(session, model);
      if (!request) {
        onNotice(t("sessionChat.model.notYet"));
        return;
      }
      const next = await agents.launch(request);
      // The new process already holds the conversation; a failed close only
      // leaves the old one running in its tab.
      await agents.disconnect(session.sessionId).catch(() => undefined);
      onReplaced(next.sessionId);
    } catch (reason) {
      onNotice(t("sessionChat.model.failed", { detail: errorText(reason) }));
    } finally {
      setSwitching(false);
    }
  }

  const inPlace = switchesModelInPlace(session);
  return (
    <div ref={menuRef} className="session-composer__model-picker">
      <button type="button" className="session-composer__model" disabled={disabled || switching}
        aria-haspopup="menu" aria-expanded={open}
        title={t(inPlace ? "sessionChat.model.change" : "sessionChat.model.changeResume")}
        onClick={() => setOpen(value => !value)}>
        {switching ? t("sessionChat.model.switching") : current}
      </button>
      {open && (
        <div className="session-composer__menu session-composer__menu--end" role="menu" aria-label={t("sessionChat.model")}>
          {choices.state === "ready" && choices.models.length > 0 && choices.models.map(model => (
            <button key={model.value} type="button" role="menuitemradio" aria-checked={model.value === session.model}
              title={model.value} onClick={() => void pick(model.value)}>
              {model.label}
            </button>
          ))}
          {choices.state === "ready" && choices.models.length === 0 && (
            <button type="button" role="menuitem" disabled>{t("sessionChat.model.none")}</button>
          )}
          {(choices.state === "loading" || choices.state === "idle") && (
            <button type="button" role="menuitem" disabled>{t("sessionChat.model.loading")}</button>
          )}
          {choices.state === "unavailable" && (
            <button type="button" role="menuitem" disabled title={choices.reason}>{t("sessionChat.model.none")}</button>
          )}
        </div>
      )}
    </div>
  );
}
