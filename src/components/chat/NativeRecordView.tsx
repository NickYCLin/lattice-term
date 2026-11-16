import { nativeReadError } from "../../app/nativeReadDiagnostics";
import { MemorySaveButton } from "./MemorySaveButton";
import { agentDisplayName } from "../../app/agentNames";
import type { ChatDefinitionId } from "../../app/agentChat";
import { createPortal } from "react-dom";
import { useModalFocus } from "../overlays/modalFocus";
import { CloseIcon } from "../icons";
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChatImageConversationContext } from "../../app/chatImagePreview";
import {
  maskNativeText,
  maskNativeValue,
  type NativeRecord,
  type NativeRecordPage,
  type NativeRecordScope,
  type NativeHistoryCursor,
} from "../../app/nativeRecords";
import { sessionToolRows } from "../../app/toolPresentation";
import type { SessionConversationMessage } from "../../app/useSessionConversation";
import { diffLineKind } from "../../app/gitChanges";
import { splitSessionAttachments } from "../../app/chatAttachments";
import { useI18n } from "../../i18n/context";
import { ChatMarkdown } from "./ChatMarkdown";
import { ChatImagePreview } from "./ChatImagePreview";
import { ReadableToolCard } from "./ReadableToolCard";
import { ConversationMessage } from "./ConversationPresentation";

function NativeImage({
  item,
  scope,
}: {
  item: NativeRecord;
  scope: NativeRecordScope;
}) {
  const { t } = useI18n();
  const [url, setUrl] = useState<string | null>(null),
    [failed, setFailed] = useState(false),
    [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const signature = JSON.stringify(scope);
  const load = () =>
    invoke<string | null>("native_conversation_image", {
      ...scope,
      imageId: item.id,
      agentId: scope.agentId ?? null,
    });
  useEffect(() => {
    let disposed = false;
    setUrl(null);
    setFailed(false);
    const run = () => {
      void load()
        .then((url) => {
          if (!disposed) {
            setUrl(url);
            setFailed(!url);
          }
        })
        .catch(() => {
          if (!disposed) setFailed(true);
        });
    };
    const observer =
      typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
              observer?.disconnect();
              run();
            }
          });
    if (observer && ref.current) observer.observe(ref.current);
    else run();
    return () => {
      disposed = true;
      observer?.disconnect();
    };
  }, [item.id, signature]);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="native-record-image"
        onClick={() => setOpen(true)}
        aria-label={t("chat.images.enlarge")}
      >
        {url ? (
          <img src={url} alt={t("chat.images.title")} />
        ) : (
          <span>
            {t(failed ? "chat.images.unavailable" : "common.loading")}
          </span>
        )}
      </button>
      {open && (
        <ChatImagePreview
          path={item.id}
          name={t("chat.images.title")}
          threadId={scope.threadId}
          workingDirectory={scope.workingDirectory}
          initialUrl={url ?? undefined}
          readImage={load}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
export function NativeRecordView({
  item,
  threadId,
  directory,
  agentId = null,
  forceOpen = false,
}: {
  item: NativeRecord;
  threadId: string;
  directory: string;
  agentId?: string | null;
  forceOpen?: boolean;
}) {
  item = maskNativeValue(item);
  const { t } = useI18n();
  const conversation = useContext(ChatImageConversationContext);
  const scope = {
    threadId,
    workingDirectory: directory,
    conversation,
    agentId,
  };
  const [expanded, setExpanded] = useState(false);
  if (item.kind === "image") return <NativeImage item={item} scope={scope} />;
  if (item.kind === "reasoning")
    return (
      <details className="chat-card chat-card--reasoning" open={forceOpen}>
        <summary>
          {t("native.reasoning")}
          {item.unreadable ? ` · ${t("native.unreadable")}` : ""}
        </summary>
        {!item.unreadable && <ChatMarkdown source={item.text} />}
      </details>
    );
  if (item.kind === "fileChange")
    return (
      <details className="chat-card chat-card--tool" open>
        <summary>
          {t("native.diff")} · {item.name}
        </summary>
        <pre className="chat-card__output chat-card__output--diff">
          {item.text.split("\n").map((line, index) => (
            <span
              className={`chat-diff__line is-${diffLineKind(line)}`}
              key={index}
            >
              {line}
              {"\n"}
            </span>
          ))}
        </pre>
      </details>
    );
  if (item.kind === "subagent")
    return (
      <details
        className="chat-card"
        onToggle={(event) => {
          if (event.target === event.currentTarget)
            setExpanded(event.currentTarget.open);
        }}
      >
        <summary>
          {t("native.subagent")} · {item.name}
        </summary>
        {expanded && (
          <NativeHistoryReader
            threadId={threadId}
            directory={directory}
            agentId={item.name}
          />
        )}
      </details>
    );
  if (item.kind === "system")
    return (
      <details
        className={`chat-card${item.isError ? " is-error" : ""}`}
        open={item.isError}
      >
        <summary>{t("native.system")}</summary>
        <div role={item.isError ? "alert" : undefined}>
          <ChatMarkdown source={item.text} />
        </div>
      </details>
    );
  return (
    <ConversationMessage
      assistant=""
      role={item.kind === "user" ? "user" : "assistant"}
      actions={(item.kind === "user" || item.kind === "assistant") && <MemorySaveButton text={item.kind === "user" ? splitSessionAttachments(item.text).text : item.text} directory={directory} cli={conversation?.definitionId ?? null} conversationId={`${conversation?.nativeSessionId ?? threadId}#${item.messageId ?? item.id}`} />}
    >
      <ChatMarkdown
        source={
          item.kind === "user"
            ? splitSessionAttachments(item.text).text
            : item.text
        }
      />
    </ConversationMessage>
  );
}
export function NativeHistoryReader({
  threadId,
  directory,
  agentId = null,
}: {
  threadId: string;
  directory: string;
  agentId?: string | null;
}) {
  const { t } = useI18n();
  const conversation = useContext(ChatImageConversationContext);
  const [pages, setPages] = useState<NativeRecordPage[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [discarded, setDiscarded] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const signature = JSON.stringify({
    threadId,
    directory,
    agentId,
    conversation,
  });
  const cursor = pages[0]?.previousCursor ?? null;
  async function read(before: NativeHistoryCursor | null) {
    if (inFlight.current) return;
    inFlight.current = true;
    const ticket = generation.current;
    setBusy(true);
    setError("");
    if (before && box.current)
      anchor.current = {
        height: box.current.scrollHeight,
        top: box.current.scrollTop,
      };
    try {
      const page = maskNativeValue(
        await invoke<NativeRecordPage>("native_conversation_page", {
          threadId,
          workingDirectory: directory,
          conversation,
          cursor: before,
          agentId,
        }),
      );
      if (ticket !== generation.current) return;
      if (before && pages.length >= 6) setDiscarded(true);
      setPages((old) => (before ? [page, ...old] : [page]).slice(0, 6));
    } catch (reason) {
      if (ticket === generation.current)
        setError(
          String(reason) === "native.unsupportedFormat"
            ? t("native.unsupportedFormat")
            : String(reason) === "native.databaseBusy"
              ? t("native.databaseBusy")
              : maskNativeText(String(reason)),
        );
    } finally {
      if (ticket === generation.current) {
        setBusy(false);
        inFlight.current = false;
      }
    }
  }
  useEffect(() => {
    generation.current++;
    inFlight.current = false;
    setPages([]);
    setDiscarded(false);
    void read(null);
    return () => {
      generation.current++;
      inFlight.current = false;
    };
  }, [signature]);
  useLayoutEffect(() => {
    if (anchor.current && box.current) {
      box.current.scrollTop =
        anchor.current.top + box.current.scrollHeight - anchor.current.height;
      anchor.current = null;
    }
  }, [pages]);
  const messages: SessionConversationMessage[] = pages
    .flatMap((page) => page.turns.flatMap((turn) => turn.items))
    .map((item) => ({
      role: item.kind === "user" ? "user" : "assistant",
      text:
        item.kind === "tool" ? (item.input ?? item.output ?? "") : item.text,
      nativeTurnId: item.turnId ?? undefined,
      nativeMessageId: item.messageId ?? undefined,
      record: item,
      ...(item.kind === "tool"
        ? {
            tool: {
              callId: item.callId ?? item.id,
              name: item.name ?? null,
              kind:
                item.input !== undefined
                  ? ("call" as const)
                  : ("result" as const),
            },
          }
        : {}),
    }));
  const rows = sessionToolRows(messages);
  return (
    <section className="native-history-reader" aria-label={t("native.history")}>
      <header>
        <button
          className="button button--ghost button--sm"
          type="button"
          disabled={busy || !cursor}
          onClick={() => void read(cursor)}
        >
          {t("native.earlier")}
        </button>
        <button
          className="button button--ghost button--sm"
          type="button"
          disabled={busy}
          onClick={() => {
            setDiscarded(false);
            void read(null);
          }}
        >
          {t("native.latest")}
        </button>
      </header>
      {busy && <p role="status">{t("common.loading")}</p>}
      {error && <p role="alert">{nativeReadError(error, t)}</p>}
      {!!pages[0]?.diagnostics?.skippedRows && <p role="status">{t("history.skippedRows", { count: pages[0].diagnostics.skippedRows })}</p>}
      {(discarded || pages.some((page) => page.warnings.length)) && (
        <p role="status">{t("native.bounded")}</p>
      )}
      <div ref={box} className="native-history-reader__messages">
        {rows.map((row) => (
          <div key={row.value.record?.id ?? row.id}>
            {row.tool ? (
              <ReadableToolCard tool={row.tool} />
            ) : row.value.record ? (
              <NativeRecordView
                item={row.value.record}
                threadId={threadId}
                directory={directory}
                agentId={agentId}
              />
            ) : null}
          </div>
        ))}
      </div>
      {!!pages.length && !cursor && <p>{t("native.beginning")}</p>}
    </section>
  );
}
export function NativeHistoryAccess({
  threadId,
  directory,
}: {
  threadId: string;
  directory: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <details
      className="native-history-access"
      onToggle={(event) => {
        if (event.target === event.currentTarget)
          setOpen(event.currentTarget.open);
      }}
    >
      <summary>{t("native.history")}</summary>
      {open && (
        <NativeHistoryReader threadId={threadId} directory={directory} />
      )}
    </details>
  );
}

/** Read-only sources use a full-size surface, without offering a composer. */
export function NativeHistoryDialog({
  title,
  threadId,
  directory,
  onClose,
  targets = [],
  onHandoff,
}: {
  targets?: readonly ChatDefinitionId[];
  onHandoff?: (definitionId: ChatDefinitionId) => void;
  title: string;
  threadId: string;
  directory: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus({ dialogRef, onEscape: onClose });
  return createPortal(
    <div
      className="scrim scrim--center native-history-dialog"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="native-history-dialog__panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header>
          <div>
            <h2>{title}</h2>
            <p>{t("native.readOnly")}</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={t("common.close")}
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </header>
        {onHandoff && (
          <div className="native-history-dialog__handoff">
            {targets.map((target) => (
              <button
                className="button button--ghost button--sm"
                key={target}
                type="button"
                onClick={() => onHandoff(target)}
              >
                {t("native.handoff", { assistant: agentDisplayName(target) })}
              </button>
            ))}
          </div>
        )}
        <NativeHistoryReader threadId={threadId} directory={directory} />
      </div>
    </div>,
    document.body,
  );
}
