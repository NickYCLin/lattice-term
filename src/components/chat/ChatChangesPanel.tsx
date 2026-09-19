import { useCallback, useEffect, useState } from "react";
import {
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
 * staging and a commit. Nothing here pushes or touches a remote.
 */
export function ChatChangesPanel({
  workingDirectory,
  busy,
  onQuote,
  onClose,
}: {
  workingDirectory: string;
  /** The assistant is mid-turn; its edits may still be landing. */
  busy: boolean;
  onQuote: (text: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Selection | null>(null);
  const [diff, setDiff] = useState<{ text: string; truncated: boolean } | null>(null);
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState("");
  const [comments, setComments] = useState<(DiffComment & { staged: boolean; index: number })[]>([]);
  const [commenting, setCommenting] = useState<number | null>(null);
  const [commentDraft, setCommentDraft] = useState("");

  const refresh = useCallback(async () => {
    setError("");
    try {
      const next = await gitStatus(workingDirectory);
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
    setWorking(true);
    setError("");
    setNotice("");
    try {
      await action();
      await refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
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
          disabled={working}
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
          aria-label={t("chat.changes.close")}
          title={t("chat.changes.close")}
        >
          <CloseIcon />
        </button>
      </header>
      <div className="chat-changes__body">
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
