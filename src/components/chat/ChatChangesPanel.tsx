import { useCallback, useEffect, useRef, useState } from "react";
import {
  gitPatch, gitBranches, gitComparison, gitPublish,
  commentsMessage,
  diffLineKind,
  diffQuote,
  nearestHunk,
  type DiffComment,
  gitCommit,
  gitDiff,
  gitStage,
  gitStatus,
  gitUnstage,
  hasUnstagedChange,
  isStaged,
  type ChangedFile,
  type GitStatus,
} from "../../app/gitChanges";
import { useI18n } from "../../i18n/context";
import { CloseIcon, RefreshIcon } from "../icons";

interface Selection {
  path: string;
  staged: boolean;
}

/**
 * What changed in the conversation's repository: files, one diff at a time,
 * staging, recoverable patch operations and explicit publishing.
 */
export function ChatChangesPanel({
  workingDirectory,
  busy,
  checkpoint,
  onWorking,
  onReview,
  onQuote,
  onClose,
}: {
  workingDirectory: string;
  /** The assistant is mid-turn; its edits may still be landing. */
  busy: boolean;
  checkpoint?: string;
  onWorking?: (working: boolean) => void;
  onReview?: () => void;
  onQuote: (text: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Selection | null>(null);
  const [diff, setDiff] = useState<{ text: string; truncated: boolean } | null>(null);
  const [message, setMessage] = useState("");
  const [branches, setBranches] = useState<{ name: string; revision: string }[]>([]);
  const [comparison, setComparison] = useState("");
  const [comparisonDiff, setComparisonDiff] = useState<{ text: string; truncated: boolean } | null>(null);
  const [restoreHunk, setRestoreHunk] = useState<number | null | undefined>();
  const [publish, setPublish] = useState<"push" | "pr" | null>(null);
  useEffect(() => { let active = true; void gitBranches(workingDirectory).then(value => { if (active) setBranches(value); }).catch(() => {}); return () => { active = false; }; }, [workingDirectory, status]);
  useEffect(() => { let active = true; setComparisonDiff(null); if (comparison) void gitComparison(workingDirectory, comparison).then(value => { if (active) setComparisonDiff(value); }).catch(reason => { if (active) setError(String(reason)); }); return () => { active = false; }; }, [workingDirectory, comparison, status]);

  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState("");
  const lock = useRef(false);
  const directoryRef = useRef(workingDirectory); directoryRef.current = workingDirectory;
  useEffect(() => { onWorking?.(working); return () => onWorking?.(false); }, [working, onWorking]);
  useEffect(() => { setSelected(null); setStatus(null); setDiff(null); setComparison(""); setComments([]); setRestoreHunk(undefined); }, [workingDirectory]);
  const [comments, setComments] = useState<(DiffComment & { staged: boolean; index: number })[]>([]);
  const [commenting, setCommenting] = useState<number | null>(null);
  const [commentDraft, setCommentDraft] = useState("");

  const refresh = useCallback(async () => {
    setError("");
    try {
      const next = await gitStatus(workingDirectory);
      if (directoryRef.current !== workingDirectory) return;
      setStatus(next);
      // Staging moves a file between the two lists; keep showing it on
      // whichever side it now has a change.
      setSelected((current) => {
        const file = current && next.files.find((entry) => entry.path === current.path);
        if (!current || !file) return null;
        const onSide = current.staged ? isStaged(file) : hasUnstagedChange(file);
        if (onSide) return current;
        return { path: current.path, staged: !current.staged };
      });
    } catch (reason) {
      if (directoryRef.current !== workingDirectory) return;
      setStatus(null);
      setError(String(reason));
    }
  }, [workingDirectory]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A finished turn is when files the assistant touched settle.
  useEffect(() => {
    if (!busy) void refresh();
  }, [busy, refresh]);

  useEffect(() => {
    setCommenting(null);
    setRestoreHunk(undefined);
    if (!selected) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    gitDiff(workingDirectory, selected.path, selected.staged)
      .then((next) => {
        if (!cancelled) setDiff(next);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [workingDirectory, selected, status]);

  async function act(action: () => Promise<unknown>) {
    if (lock.current || busy) return; lock.current = true;
    setWorking(true);
    setError("");
    setNotice("");
    try {
      await action();
      await refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      lock.current = false;
      setWorking(false);
    }
  }

  const staged = status?.files.filter(isStaged) ?? [];
  const unstaged = status?.files.filter(hasUnstagedChange) ?? [];

  const row = (file: ChangedFile, side: "staged" | "unstaged") => {
    const isStagedSide = side === "staged";
    const letter = isStagedSide ? file.staged : file.unstaged;
    const active = selected?.path === file.path && selected.staged === isStagedSide;
    return (
      <li key={`${side}:${file.path}`} className={active ? "is-active" : undefined}>
        <button
          type="button"
          className="chat-changes__file"
          onClick={() => setSelected({ path: file.path, staged: isStagedSide })}
          title={file.originalPath ? `${file.originalPath} → ${file.path}` : file.path}
        >
          <span className={`chat-changes__letter is-${letter === "?" ? "new" : letter}`}>{letter}</span>
          <span className="chat-changes__path">{file.path}</span>
        </button>
        <button
          type="button"
          className="button button--ghost button--sm"
          disabled={working || busy}
          onClick={() =>
            void act(() =>
              isStagedSide ? gitUnstage(workingDirectory, [file.path]) : gitStage(workingDirectory, [file.path]),
            )
          }
        >
          {t(isStagedSide ? "chat.changes.unstage" : "chat.changes.stage")}
        </button>
      </li>
    );
  };

  return (
    <section className="chat-changes" aria-label={t("chat.changes")}>
      <header className="chat-terminal__head">
        <span className="chat-card__label">{t("chat.changes")}</span>
        <code className="chat-terminal__path">
          {status?.branch ?? ""}
          {status ? ` · ${t("chat.changes.count", { count: status.files.length })}` : ""}
        </code>
        {comments.length > 0 && (
          <button
            type="button"
            className="button button--secondary button--sm"
            onClick={() => {
              onQuote(commentsMessage(comments));
              setComments([]);
            }}
          >
            {t("chat.changes.sendComments", { count: comments.length })}
          </button>
        )}
        <button
          type="button"
          className="button button--ghost button--sm"
          onClick={() => void refresh()}
          aria-label={t("chat.changes.refresh")}
          title={t("chat.changes.refresh")}
        >
          <RefreshIcon />
        </button>
        <button
          type="button"
          className="button button--ghost button--sm"
          onClick={onClose}
          disabled={working}
          aria-label={t("chat.changes.close")}
          title={t("chat.changes.close")}
        >
          <CloseIcon />
        </button>
      </header>
      <div className="chat-changes__toolbar">
        <select className="input" value={comparison} onChange={event => setComparison(event.target.value)} aria-label={t("chat.changes.compare")}>
          <option value="">{t("chat.changes.workingTree")}</option>
          {checkpoint && <option value={checkpoint}>{t("chat.changes.previousTurn")}</option>}
          {branches.map(branch => <option key={branch.name} value={branch.revision}>{branch.name}</option>)}
        </select>
        {onReview && <button className="button button--ghost button--sm" disabled={working || busy} onClick={onReview}>{t("chat.changes.review")}</button>}
        <button className="button button--ghost button--sm" disabled={working || busy} onClick={() => setPublish("push")}>{t("chat.changes.push")}</button>
        <button className="button button--ghost button--sm" disabled={working || busy} onClick={() => setPublish("pr")}>{t("chat.changes.pr")}</button>
      </div>
      {publish && <div className="chat-settings" role="group" aria-label={t("chat.changes.publishConfirm")}>
        <p>{t("chat.changes.publishConfirm")}</p><button className="button button--primary button--sm" disabled={working || busy} onClick={() => void act(async () => { const result = await gitPublish(workingDirectory, publish === "pr"); setNotice(result); setPublish(null); })}>{t(publish === "pr" ? "chat.changes.pr" : "chat.changes.push")}</button>
        <button className="button button--ghost button--sm" disabled={working} onClick={() => setPublish(null)}>{t("common.cancel")}</button>
      </div>}
      {comparison && <div className="chat-changes__comparison"><pre className="chat-diff">{comparisonDiff?.text || t("chat.changes.clean")}</pre>{comparisonDiff?.truncated && <p>{t("chat.changes.truncated")}</p>}</div>}
      <div className="chat-changes__body" hidden={Boolean(comparison)}>
        <div className="chat-changes__list">
          {error && <p className="field__error">{error}</p>}
          {notice && <p className="chat-settings__hint" role="status">{notice}</p>}
          {status && status.files.length === 0 && <p className="chat-settings__hint">{t("chat.changes.clean")}</p>}
          {staged.length > 0 && (
            <>
              <h4>{t("chat.changes.staged")}</h4>
              <ul>{staged.map((file) => row(file, "staged"))}</ul>
            </>
          )}
          {unstaged.length > 0 && (
            <>
              <h4>
                {t("chat.changes.unstaged")}
                <button
                  type="button"
                  className="button button--ghost button--sm"
                  disabled={working}
                  onClick={() => void act(() => gitStage(workingDirectory, unstaged.map((file) => file.path)))}
                >
                  {t("chat.changes.stageAll")}
                </button>
              </h4>
              <ul>{unstaged.map((file) => row(file, "unstaged"))}</ul>
            </>
          )}
          {status && (
            <form
              className="chat-changes__commit"
              onSubmit={(event) => {
                event.preventDefault();
                void act(async () => {
                  const hash = await gitCommit(workingDirectory, message);
                  setMessage("");
                  setNotice(t("chat.changes.committed", { hash }));
                });
              }}
            >
              <textarea
                className="input"
                rows={3}
                value={message}
                placeholder={t("chat.changes.messagePlaceholder")}
                onChange={(event) => setMessage(event.target.value)}
                disabled={working}
              />
              <button
                type="submit"
                className="button button--primary button--sm"
                disabled={working || busy || staged.length === 0 || !message.trim()}
                title={busy ? t("chat.changes.waitForTurn") : undefined}
              >
                {t("chat.changes.commit", { count: staged.length })}
              </button>
            </form>
          )}
        </div>
        <div className="chat-changes__diff">
          {selected && diff ? (
            <>
              <div className="chat-changes__diffHead">
                <code>{selected.path}</code>
                <button
                  type="button"
                  className="button button--ghost button--sm"
                  onClick={() => onQuote(diffQuote(selected.path, diff.text))}
                  disabled={!diff.text}
                >
                  {t("chat.changes.quote")}
                </button>
              </div>
              {!selected.staged && <button type="button" className="button button--ghost button--sm" disabled={working || busy || diff.truncated || !diff.text} onClick={() => setRestoreHunk(null)}>{t("chat.changes.restoreFile")}</button>}
              {restoreHunk !== undefined && <div role="group" className="chat-settings">
                <p>{t("chat.changes.restoreConfirm")}</p>
                <button type="button" className="button button--danger button--sm" disabled={working || busy} onClick={() => void act(async () => { const backup = await gitPatch(workingDirectory, selected.path, false, diff.text, "restore", restoreHunk); setRestoreHunk(undefined); setNotice(t("chat.changes.recovery", { path: backup })); })}>{t("chat.changes.restore")}</button>
                <button type="button" className="button button--ghost button--sm" onClick={() => setRestoreHunk(undefined)}>{t("common.cancel")}</button>
              </div>}
              <div className="chat-diff" role="list">
                {diff.text
                  ? (() => {
                      const lines = diff.text.split("\n");
                      return lines.map((line, index) => {
                        const kind = diffLineKind(line);
                        const notes = comments.filter(
                          (comment) =>
                            comment.path === selected.path && comment.staged === selected.staged && comment.index === index,
                        );
                        return (
                          <div key={index} role="listitem">
                            {kind === "meta" || kind === "hunk" ? (
                              <span className={`chat-diff__line is-${kind}`}>{line}</span>
                            ) : (
                              <button
                                type="button"
                                className={`chat-diff__line is-${kind} is-commentable`}
                                title={t("chat.changes.comment")}
                                onClick={() => {
                                  setCommenting(index);
                                  setCommentDraft("");
                                }}
                              >
                                {line || " "}
                              </button>
                            )}
                            {kind === "hunk" && !diff.truncated && <div className="chat-changes__hunkActions">
                              <button type="button" className="button button--ghost button--sm" disabled={working || busy} onClick={() => void act(() => gitPatch(workingDirectory, selected.path, selected.staged, diff.text, selected.staged ? "unstage" : "stage", lines.slice(0, index).filter(line => line.startsWith("@@ ")).length))}>{t(selected.staged ? "chat.changes.unstageHunk" : "chat.changes.stageHunk")}</button>
                              {!selected.staged && <button type="button" className="button button--ghost button--sm" disabled={working || busy} onClick={() => setRestoreHunk(lines.slice(0, index).filter(line => line.startsWith("@@ ")).length)}>{t("chat.changes.restoreHunk")}</button>}
                            </div>}
                            {notes.map((note) => (
                              <p key={note.text} className="chat-diff__note">
                                {note.text}
                                <button
                                  type="button"
                                  className="button button--ghost button--sm"
                                  onClick={() => setComments((current) => current.filter((entry) => entry !== note))}
                                >
                                  {t("chat.changes.removeComment")}
                                </button>
                              </p>
                            ))}
                            {commenting === index && (
                              <form
                                className="chat-diff__compose"
                                onSubmit={(event) => {
                                  event.preventDefault();
                                  if (!commentDraft.trim()) return;
                                  setComments((current) => [
                                    ...current,
                                    {
                                      path: selected.path,
                                      staged: selected.staged,
                                      index,
                                      hunk: nearestHunk(lines, index),
                                      line,
                                      text: commentDraft.trim(),
                                    },
                                  ]);
                                  setCommenting(null);
                                }}
                              >
                                <textarea
                                  className="input"
                                  rows={2}
                                  autoFocus
                                  value={commentDraft}
                                  placeholder={t("chat.changes.commentPlaceholder")}
                                  onChange={(event) => setCommentDraft(event.target.value)}
                                />
                                <button type="submit" className="button button--primary button--sm" disabled={!commentDraft.trim()}>
                                  {t("chat.changes.addComment")}
                                </button>
                                <button type="button" className="button button--ghost button--sm" onClick={() => setCommenting(null)}>
                                  {t("common.cancel")}
                                </button>
                              </form>
                            )}
                          </div>
                        );
                      });
                    })()
                  : t("chat.changes.noDiff")}
              </div>
              {diff.truncated && <p className="chat-settings__hint">{t("chat.changes.truncated")}</p>}
            </>
          ) : (
            <p className="chat-settings__hint">{t("chat.changes.pick")}</p>
          )}
        </div>
      </div>
    </section>
  );
}
