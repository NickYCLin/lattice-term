import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../i18n/context";
export function ChatWorktree({ directory, busy, onOpen }: { directory: string; busy: boolean; onOpen: (directory: string, handoff: boolean) => void }) {
  const { t } = useI18n();
  const [trees, setTrees] = useState<{ path: string; branch: string | null; current: boolean }[]>([]);
  const [destination, setDestination] = useState(""); const [branch, setBranch] = useState("");
  const [handoff, setHandoff] = useState(true); const [working, setWorking] = useState(false); const [error, setError] = useState("");
  const [remove, setRemove] = useState<string | null>(null);
  const refresh = () => invoke<typeof trees>("git_worktrees", { workingDirectory: directory }).then(setTrees);
  useEffect(() => { let active = true; void invoke<typeof trees>("git_worktrees", { workingDirectory: directory }).then(value => { if (active) setTrees(value); }).catch(reason => { if (active) setError(String(reason)); }); return () => { active = false; }; }, [directory]);
  async function act(action: () => Promise<void>) { if (busy || working) return; setWorking(true); setError(""); try { await action(); await refresh(); } catch (reason) { setError(String(reason)); } finally { setWorking(false); } }
  return <section className="chat-settings"><h3>{t("chat.worktree.title")}</h3>
    <p className="chat-settings__hint">{t("chat.worktree.hint")}</p>
    {error && <p role="alert" className="field__error">{error}</p>}
    <label><input type="checkbox" checked={handoff} onChange={event => setHandoff(event.target.checked)} />{t("chat.worktree.handoff")}</label>
    <ul>{trees.map((tree, index) => <li key={tree.path}><code>{tree.branch ?? "detached"} · {tree.path}</code>
      {!tree.current && <button type="button" className="button button--ghost button--sm" disabled={busy || working} onClick={() => onOpen(tree.path, handoff)}>{t("chat.worktree.open")}</button>}
      {index > 0 && !tree.current && <button type="button" className="button button--ghost button--sm" disabled={busy || working} onClick={() => setRemove(tree.path)}>{t("chat.worktree.remove")}</button>}
    </li>)}</ul>
    {remove && <div><p>{t("chat.worktree.removeConfirm", { path: remove })}</p><button className="button button--danger button--sm" disabled={busy || working} onClick={() => void act(async () => { await invoke("git_worktree_remove", { workingDirectory: directory, destination: remove }); setRemove(null); })}>{t("chat.worktree.remove")}</button><button className="button button--ghost button--sm" onClick={() => setRemove(null)}>{t("common.cancel")}</button></div>}
    <form onSubmit={event => { event.preventDefault(); void act(async () => { const path = await invoke<string>("git_worktree_create", { workingDirectory: directory, destination, branch }); onOpen(path, handoff); setDestination(""); setBranch(""); }); }}>
      <label>{t("chat.worktree.branch")}<input className="input" value={branch} onChange={event => setBranch(event.target.value)} disabled={busy || working} required /></label>
      <label>{t("chat.worktree.path")}<input className="input" value={destination} onChange={event => setDestination(event.target.value)} disabled={busy || working} required /></label>
      <button className="button button--primary button--sm" disabled={busy || working || !branch.trim() || !destination.trim()}>{t("chat.worktree.create")}</button>
    </form>
  </section>;
}
