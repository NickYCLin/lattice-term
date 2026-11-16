import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { checkedRecentProjects, projectCandidates, readRecentProjects, type RecentProject } from "../../app/recentProjects";
import { displayPath } from "../../app/displayPath";
import { useI18n } from "../../i18n/context";
import { FolderIcon } from "../icons";
import { ComposerMenu } from "./ComposerMenu";

export function ComposerProjectMenu({ workingDirectory, disabled, candidates, onChoose, onChange }: {
  workingDirectory: string; disabled: boolean; candidates: readonly RecentProject[]; onChoose: () => void; onChange: (path: string) => void;
}) {
  const { t } = useI18n(); const [open, setOpen] = useState(false), [query, setQuery] = useState("");
  const [rows, setRows] = useState<RecentProject[]>([]), [identities, setIdentities] = useState<{ path: string; canonicalPath: string | null }[]>([]);
  const [loading, setLoading] = useState(false), [choosing, setChoosing] = useState(false), [problem, setProblem] = useState(false);
  const generation = useRef(0);
  const live = useRef({ open, disabled }); live.current = { open, disabled };
  useEffect(() => () => { live.current = { open:false, disabled:true }; }, []);
  const candidateSnapshot = useRef(candidates); candidateSnapshot.current = candidates;
  useEffect(() => {
    if (!open) return;
    const ticket = ++generation.current;
    let disposed = false; setChoosing(false); setQuery(""); setProblem(false); setLoading(true); setIdentities([]);
    const rows = projectCandidates([...readRecentProjects(), ...candidateSnapshot.current]); setRows(rows);
    void invoke<{ path: string; canonicalPath: string | null }[]>("project_directory_identities", { paths: rows.map(row => row.path) })
      .then(next => { if (!disposed && Array.isArray(next)) setIdentities(next); })
      .catch(() => { if (!disposed) setProblem(true); }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; if (generation.current === ticket) generation.current++; };
  }, [open]);
  return <ComposerMenu label={t("chat.projects.menu")} disabled={disabled} open={open} onOpenChange={setOpen} searchable
    className="session-composer__place session-composer__directory-button"
    trigger={<><FolderIcon size={14} /><span>{workingDirectory ? (displayPath(workingDirectory).split(/[\\/]/).filter(Boolean).pop() ?? displayPath(workingDirectory)) : t("chat.directory.none")}</span></>}>
    {close => <>
      <input className="input" type="search" value={query} onChange={event => setQuery(event.target.value)} aria-label={t("chat.projects.search")} placeholder={t("chat.projects.search")} />
      {loading && <p role="status">{t("common.loading")}</p>}
      {problem && <p role="alert">{t("chat.projects.unverified")}</p>}
      <div role="menu" aria-label={t("chat.projects.recent")}>
        {checkedRecentProjects(rows, identities, query).map(row => <button type="button" key={row.path} role="menuitem" className="composer-menu__item"
          disabled={loading || choosing || !row.canonicalPath} title={displayPath(row.path)} onClick={() => {
            const ticket = generation.current; setChoosing(true); setProblem(false);
            void invoke<{ path: string; canonicalPath: string | null }[]>("project_directory_identities", { paths: [row.path] }).then(next => {
              if (ticket !== generation.current || !live.current.open || live.current.disabled) return;
              if (next?.find(item => item.path === row.path)?.canonicalPath) { close(); onChange(row.path); }
              else { setIdentities(current => current.map(item => item.path === row.path ? { ...item, canonicalPath:null } : item)); setProblem(true); }
            }).catch(() => setProblem(true)).finally(() => { if (ticket === generation.current) setChoosing(false); });
          }}><span>{displayPath(row.path).split(/[\\/]/).filter(Boolean).pop() ?? displayPath(row.path)}</span><small>{displayPath(row.path)}{!loading && !row.canonicalPath ? ` · ${t("chat.projects.unavailable")}` : ""}</small></button>)}
        <button type="button" role="menuitem" className="composer-menu__item" disabled={choosing} onClick={() => { close(); onChange(""); }}>{t("chat.directory.none")}</button>
        <button type="button" role="menuitem" className="composer-menu__item" disabled={choosing} onClick={() => { close(); onChoose(); }}>{t("chat.projects.other")}</button>
      </div>
    </>}
  </ComposerMenu>;
}
