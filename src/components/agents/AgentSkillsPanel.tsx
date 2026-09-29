import { useEffect, useMemo, useRef, useState } from "react";
import {
  profileCapable,
  profilesFor,
  type ChatAccountProfile,
} from "../../app/chatAccountProfiles";
import type { AgentDefinition } from "../../app/useAgentSessions";
import { useI18n } from "../../i18n/context";
import { skillSourceLabel } from "../chat/ChatSkillPicker";
import { Callout } from "../common/Callout";
import { AgentIcon } from "../icons";

interface DiscoveredSkill {
  name: string;
  description: string | null;
  source: string;
  kind?: string;
}

interface SkillTarget {
  id: string;
  definitionId: "codex" | "claude";
  label: string;
  profileConfigPath: string | null;
}

function skillTargets(
  catalog: readonly AgentDefinition[],
  profiles: readonly ChatAccountProfile[],
  defaultAccountLabel: string,
): SkillTarget[] {
  return catalog.flatMap((definition) => {
    if (!definition.installed || !profileCapable(definition.id)) return [];
    const definitionId = definition.id;
    const defaultTarget: SkillTarget = {
      id: `${definitionId}:default`,
      definitionId,
      label: `${definition.label} · ${defaultAccountLabel}`,
      profileConfigPath: null,
    };
    const profileTargets: SkillTarget[] = profilesFor(profiles, definitionId).map((profile) => ({
      id: `${definitionId}:${profile.id}`,
      definitionId,
      label: `${definition.label} · ${profile.name}`,
      profileConfigPath: profile.configDirectory,
    }));
    return [defaultTarget, ...profileTargets];
  });
}

export function AgentSkillsPanel({
  catalog,
  accountProfiles,
  projectDirectory,
}: {
  catalog: readonly AgentDefinition[];
  accountProfiles: readonly ChatAccountProfile[];
  projectDirectory: string;
}) {
  const { t } = useI18n();
  const requestRef = useRef(0);
  const [selectedTargetId, setSelectedTargetId] = useState("");
  const [skills, setSkills] = useState<DiscoveredSkill[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const normalizedDirectory = projectDirectory.trim();
  const targets = useMemo(
    () => skillTargets(catalog, accountProfiles, t("agents.account.default")),
    [accountProfiles, catalog, t],
  );
  const activeTarget = targets.find((target) => target.id === selectedTargetId) ?? targets[0] ?? null;

  useEffect(() => {
    if (!targets.some((target) => target.id === selectedTargetId)) {
      setSelectedTargetId(targets[0]?.id ?? "");
    }
  }, [selectedTargetId, targets]);

  useEffect(() => {
    const request = ++requestRef.current;
    if (!normalizedDirectory || !activeTarget) {
      setSkills(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    setSkills(null);
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const result = await invoke<DiscoveredSkill[]>("agent_chat_skills", {
          definitionId: activeTarget.definitionId,
          workingDirectory: normalizedDirectory,
          profileConfigPath: activeTarget.profileConfigPath,
        });
        if (request !== requestRef.current) return;
        setSkills(result.filter((skill) => !skill.kind || skill.kind === "skill"));
      } catch (reason) {
        if (request !== requestRef.current) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (request === requestRef.current) setLoading(false);
      }
    })();
  }, [activeTarget, normalizedDirectory]);

  useEffect(
    () => () => {
      requestRef.current += 1;
    },
    [],
  );

  return (
    <section className="agents-skills">
      <div className="agents-section-heading">
        <div>
          <span className="eyebrow">{t("agents.skills.eyebrow")}</span>
          <h3>{t("agents.skills.title")}</h3>
        </div>
        <span className={`badge ${loading ? "tone-neutral" : "tone-ok"}`}>
          {loading
            ? t("agents.skills.discovering")
            : t("agents.skills.count", { count: skills?.length ?? 0 })}
        </span>
      </div>
      <p className="agents-skills__body">{t("agents.skills.body")}</p>

      {!normalizedDirectory ? (
        <Callout tone="info">{t("agents.skills.directoryRequired")}</Callout>
      ) : targets.length === 0 ? (
        <Callout tone="info">{t("agents.skills.agentRequired")}</Callout>
      ) : (
        <>
          <label className="field agents-skills__target">
            <span className="field__label">{t("agents.skills.target")}</span>
            <select
              className="select"
              value={activeTarget?.id ?? ""}
              onChange={(event) => setSelectedTargetId(event.currentTarget.value)}
            >
              {targets.map((target) => (
                <option key={target.id} value={target.id}>{target.label}</option>
              ))}
            </select>
          </label>

          {error && (
            <Callout tone="danger" title={t("agents.skills.failedTitle")}>
              {t("agents.skills.failed", { detail: error })}
            </Callout>
          )}
          {loading && <p className="agents-skills__loading">{t("agents.skills.discoveringBody")}</p>}
          {skills?.length === 0 && !loading && (
            <p className="agents-skills__empty">{t("agents.skills.empty")}</p>
          )}
          {skills && skills.length > 0 && !loading && (
            <ul className="agents-skills__list" aria-label={t("agents.skills.title")}>
              {skills.map((skill) => (
                <li key={`${skill.source}:${skill.name}`}>
                  <span className="agents-skills__icon" aria-hidden="true"><AgentIcon size={14} /></span>
                  <div>
                    <div className="agents-skills__name-row">
                      <strong>{skill.name}</strong>
                      <span className="badge tone-neutral">{skillSourceLabel(skill.source, t)}</span>
                    </div>
                    {skill.description && <p>{skill.description}</p>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
