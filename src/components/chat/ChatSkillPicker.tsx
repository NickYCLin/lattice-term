import { useEffect, useRef, useState } from "react";
import type { ChatDefinitionId, ChatMention } from "../../app/agentChat";
import { hasDesktopBackend } from "../../app/nativeRuntime";
import { useI18n, type MessageKey } from "../../i18n/context";

interface Skill {
  name: string;
  description: string | null;
  source: string;
  kind?: ChatMention["kind"];
  path?: string | null;
  token?: string | null;
}

const SOURCE_KEYS: Record<string, MessageKey> = {
  帳號: "chat.skills.source.account",
  專案: "chat.skills.source.project",
  外掛: "chat.skills.source.plugin",
  內建: "chat.skills.source.builtin",
  系統管理: "chat.skills.source.admin",
  App: "chat.skills.source.app",
};

/** The backend names where an entry came from in fixed words; show them in the interface language. */
export function skillSourceLabel(source: string, t: (key: MessageKey) => string): string {
  const key = SOURCE_KEYS[source];
  return key ? t(key) : source;
}

/** The structured pick Codex receives, when the entry carries one. */
export function skillPick(definitionId: ChatDefinitionId, skill: Skill): ChatMention | null {
  if (definitionId !== "codex" || !skill.path || !skill.token) return null;
  return { kind: skill.kind ?? "skill", name: skill.name, path: skill.path, token: skill.token };
}

/**
 * How a skill is named in a message. Codex has its own `$skill` mention;
 * the others are asked plainly, which every one of them follows.
 */
export function skillMention(definitionId: ChatDefinitionId, name: string): string {
  const safe = name.replace(/[`\n\r]/g, "").trim();
  return definitionId === "codex" ? `$${safe.replace(/\s+/g, "-")} ` : `Use the \`${safe}\` skill. `;
}

/** Lists the skills this assistant can find for the conversation and inserts one. */
export function ChatSkillPicker({
  definitionId,
  workingDirectory,
  profileConfigPath,
  disabled,
  onPick,
}: {
  definitionId: ChatDefinitionId;
  workingDirectory: string;
  profileConfigPath: string | null;
  disabled: boolean;
  onPick: (text: string, mention: ChatMention | null) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !hasDesktopBackend()) return;
    let cancelled = false;
    setError("");
    void import("@tauri-apps/api/core")
      .then(({ invoke }) =>
        invoke<Skill[]>("agent_chat_skills", { definitionId, workingDirectory, profileConfigPath }),
      )
      .then((next) => {
        if (!cancelled) setSkills(next);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [open, definitionId, workingDirectory, profileConfigPath]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [open]);

  const needle = filter.trim().toLowerCase();
  const shown = (skills ?? []).filter(
    (skill) => !needle || skill.name.toLowerCase().includes(needle) || skill.description?.toLowerCase().includes(needle),
  );

  return (
    <div className="chat-skills" ref={root}>
      <button
        type="button"
        className="button button--ghost button--sm"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        {t(definitionId === "codex" ? "chat.skills.withPlugins" : "chat.skills")}
      </button>
      {open && (
        <div className="chat-skills__menu" role="dialog" aria-label={t("chat.skills")}>
          <input
            className="input"
            autoFocus
            value={filter}
            placeholder={t(definitionId === "codex" ? "chat.skills.filterWithPlugins" : "chat.skills.filter")}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setOpen(false);
            }}
          />
          {error && <p className="field__error">{error}</p>}
          {!skills && !error && <p className="chat-settings__hint">{t("chat.skills.loading")}</p>}
          {skills && shown.length === 0 && <p className="chat-settings__hint">{t("chat.skills.none")}</p>}
          <ul>
            {shown.map((skill) => (
              <li key={skill.path ?? `${skill.source}:${skill.name}`}>
                <button
                  type="button"
                  onClick={() => {
                    const pick = skillPick(definitionId, skill);
                    onPick(pick ? `${pick.token} ` : skillMention(definitionId, skill.name), pick);
                    setOpen(false);
                  }}
                >
                  <strong>{skill.name}</strong>
                  <span className="chat-chip">{skillSourceLabel(skill.source, t)}</span>
                  {skill.description && <small>{skill.description}</small>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
