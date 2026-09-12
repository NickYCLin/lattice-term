import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, WheelEvent } from "react";
import type { RemoteApi, RemoteInput, RemoteSessionSummary } from "../../app/useRemoteSessions";
import type { ThemeId } from "../../app/themes";
import { useI18n } from "../../i18n/context";
import { FolderIcon, ScreenShareIcon, ShieldIcon, TerminalIcon } from "../icons";
import {
  CanvasSoftKeyboard,
  CanvasInputSequence,
  canvasTextTokens,
  isCanvasImeKey,
} from "./CanvasSoftKeyboard";
import { CanvasCaptureControls } from "./CanvasCaptureControls";
import { keysymFor } from "./keysym";
import { RemoteCommandPane } from "./RemoteCommandPane";
import { RemoteFilesPane } from "./RemoteFilesPane";
import {
  RemotePointerInputState,
  type RemotePointerTransition,
} from "./remotePointerInput";
import { RemoteTerminalView } from "./RemoteTerminalView";

export function RemotePane({
  session,
  remote,
  theme,
}: {
  session: RemoteSessionSummary;
  remote: RemoteApi;
  /** Only used by the terminal view to follow palette changes. */
  theme: ThemeId;
}) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pendingMove = useRef<RemoteInput | null>(null);
  const moveFrame = useRef<number | null>(null);
  const pointerInput = useRef(new RemotePointerInputState());
  const keyboardInputSequence = useRef(new CanvasInputSequence());
  const [filesOpen, setFilesOpen] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const interactive = !session.viewOnly;
  // The Remote API container changes whenever a frame updates, while the
  // memoised input method remains stable. Depending on the whole object would
  // run the cleanup below every frame and release an active drag at ~10 FPS.
  const remoteInput = remote.input;

  const send = useCallback(
    (request: RemoteInput) => {
      if (!interactive) return;
      void remoteInput(session.sessionId, request).catch(() => undefined);
    },
    [interactive, remoteInput, session.sessionId],
  );

  useEffect(() => {
    const frame = session.frame;
    const canvas = canvasRef.current;
    if (!frame || !canvas) return;
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) return;
      canvas.width = frame.width;
      canvas.height = frame.height;
      context.drawImage(image, 0, 0, frame.width, frame.height);
    };
    image.src = frame.dataUrl;
    return () => {
      cancelled = true;
    };
  }, [session.frame]);

  useEffect(
    () => () => {
      if (moveFrame.current !== null) cancelAnimationFrame(moveFrame.current);
      pointerInput.current.reset();
      if (interactive) send({ kind: "releaseAll" });
    },
    [interactive, send],
  );

  function position(event: PointerEvent<HTMLCanvasElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(
          session.width - 1,
          Math.round(((event.clientX - bounds.left) / bounds.width) * session.width),
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          session.height - 1,
          Math.round(((event.clientY - bounds.top) / bounds.height) * session.height),
        ),
      ),
    };
  }

  function pointerMove(event: PointerEvent<HTMLCanvasElement>) {
    if (!interactive) return;
    const transition = pointerInput.current.move(
      event.pointerId,
      event.isPrimary,
      event.buttons,
    );
    if (!transition.accepted) return;
    const point = position(event);
    if (transition.buttonChanges.length > 0) {
      clearPendingPointerMove();
      send({ kind: "mouseMove", ...point });
      sendPointerButtons(transition);
      return;
    }
    pendingMove.current = { kind: "mouseMove", ...point };
    if (moveFrame.current !== null) return;
    moveFrame.current = requestAnimationFrame(() => {
      moveFrame.current = null;
      if (pendingMove.current) send(pendingMove.current);
      pendingMove.current = null;
    });
  }

  function pointerButton(
    event: PointerEvent<HTMLCanvasElement>,
    pressed: boolean,
  ) {
    if (!interactive) return;
    const transition = pressed
      ? pointerInput.current.begin(
          event.pointerId,
          event.isPrimary,
          event.buttons,
        )
      : pointerInput.current.end(
          event.pointerId,
          event.isPrimary,
          event.buttons,
        );
    if (!transition.accepted) return;
    event.preventDefault();
    event.currentTarget.focus();
    if (pressed) {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Older WebViews may lack capture; leave/cancel still releases input.
      }
    }
    clearPendingPointerMove();
    send({ kind: "mouseMove", ...position(event) });
    sendPointerButtons(transition);
    if (
      !pressed &&
      event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function clearPendingPointerMove() {
    pendingMove.current = null;
    if (moveFrame.current === null) return;
    cancelAnimationFrame(moveFrame.current);
    moveFrame.current = null;
  }

  function sendPointerButtons(transition: RemotePointerTransition) {
    for (const change of transition.buttonChanges) {
      send({ kind: "mouseButton", ...change });
    }
  }

  function endPointerUnexpectedly(event: PointerEvent<HTMLCanvasElement>) {
    if (!interactive) return;
    const transition = pointerInput.current.cancel(
      event.pointerId,
      event.isPrimary,
    );
    if (!transition.accepted) return;
    clearPendingPointerMove();
    if (transition.releaseAll) send({ kind: "releaseAll" });
  }

  function pointerLeave(event: PointerEvent<HTMLCanvasElement>) {
    if (!interactive || !event.isPrimary) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) return;
    if (pointerInput.current.activePointerId === event.pointerId) {
      endPointerUnexpectedly(event);
    }
  }

  function wheel(event: WheelEvent<HTMLCanvasElement>) {
    if (!interactive) return;
    event.preventDefault();
    const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
    const delta = horizontal ? event.deltaX : event.deltaY;
    if (delta === 0) return;
    send({ kind: "wheel", horizontal, units: Math.sign(delta) });
  }

  function keyboard(event: KeyboardEvent<HTMLCanvasElement>, pressed: boolean) {
    if (!interactive) return;
    if (isCanvasImeKey(event.key, event.nativeEvent.isComposing)) return;
    const keysym = keysymFor(event.key, event.code);
    if (keysym === null) return;
    event.preventDefault();
    send({ kind: "key", keysym, pressed });
  }

  function tapKeyboardKey(key: string, code: string): boolean {
    const keysym = keysymFor(key, code);
    if (keysym === null) return false;
    sendKeyboard({ kind: "key", keysym, pressed: true });
    sendKeyboard({ kind: "key", keysym, pressed: false });
    return true;
  }

  function sendKeyboard(request: RemoteInput) {
    if (!interactive) return;
    keyboardInputSequence.current.enqueue(() =>
      remoteInput(session.sessionId, request),
    );
  }

  function typeKeyboardText(text: string) {
    for (const token of canvasTextTokens(text)) {
      if (token.kind === "key") {
        tapKeyboardKey(token.key, token.code);
      } else {
        tapKeyboardKey(token.character, "");
      }
    }
  }

  return (
    <div className="remote-pane">
      <div className="remote-toolbar">
        <span className="remote-toolbar__identity truncate">
          {session.terminal ? (
            <TerminalIcon size={14} />
          ) : (
            <ScreenShareIcon size={14} />
          )}
          {session.agentName}
        </span>
        <span className="remote-toolbar__status">
          <ShieldIcon size={13} />
          {t("remote.session.encrypted")}
        </span>
        {!session.terminal && (
          <>
            <span className="remote-toolbar__resolution mono">
              {session.width} × {session.height}
            </span>
            <CanvasCaptureControls
              canvasRef={canvasRef}
              ready={session.frame !== null}
              label={session.agentName}
            />
          </>
        )}
        {interactive && !session.terminal && !filesOpen && !commandsOpen && (
          <CanvasSoftKeyboard
            buttonLabel={t("remote.keyboard.open")}
            closeButtonLabel={t("remote.keyboard.close")}
            inputLabel={t("remote.keyboard.input")}
            onText={typeKeyboardText}
            onKeyTap={tapKeyboardKey}
            onReleaseAll={() => sendKeyboard({ kind: "releaseAll" })}
          />
        )}
        {!!session.commandShells && <button type="button" className={`capture-button${commandsOpen ? " is-active" : ""}`} aria-expanded={commandsOpen} aria-pressed={commandsOpen} aria-label={t("remote.commands.title")} onClick={() => { setCommandsOpen(value => !value); setFilesOpen(false); }}>
          <TerminalIcon size={13} /><span className="capture-button__label">{t("remote.commands.title")}</span>
        </button>}
        {session.fileTransfer && (
          <button
            type="button"
            className={`capture-button${filesOpen ? " is-active" : ""}`}
            onClick={() => { setFilesOpen((current) => !current); setCommandsOpen(false); }}
            aria-pressed={filesOpen}
            aria-expanded={filesOpen}
            aria-label={t("remote.files.toggle")}
            data-tooltip={t("remote.files.toggle")}
          >
            <FolderIcon size={13} />
            <span className="capture-button__label">{t("remote.files.toggle")}</span>
          </button>
        )}
        <span className={interactive ? "badge tone-ok" : "badge tone-info"}>
          {interactive
            ? t("remote.session.interactive")
            : t("remote.session.viewOnly")}
        </span>
      </div>

      <div className={`remote-workspace${filesOpen || commandsOpen ? " remote-workspace--files" : ""}`}>
        {!!session.commandShells && <RemoteCommandPane key={session.sessionId} session={session} hidden={!commandsOpen} />}
        {filesOpen && session.fileTransfer && (
          <aside
            className="remote-workspace__files"
            aria-label={t("remote.files.toggle")}
          >
            <RemoteFilesPane session={session} remote={remote} />
          </aside>
        )}
        {session.terminal ? (
          <RemoteTerminalView session={session} remote={remote} theme={theme} />
        ) : (
        <div className="remote-canvas" aria-live="polite">
          <canvas
            ref={canvasRef}
            className={
              interactive
                ? "remote-frame-canvas remote-frame-canvas--interactive rdp-canvas"
                : "remote-frame-canvas remote-frame-canvas--view-only"
            }
            width={session.width}
            height={session.height}
            tabIndex={interactive ? 0 : undefined}
            role={interactive ? "application" : "img"}
            aria-label={t("remote.session.frameAlt", { name: session.agentName })}
            onPointerMove={interactive ? pointerMove : undefined}
            onPointerDown={
              interactive ? (event) => pointerButton(event, true) : undefined
            }
            onPointerUp={
              interactive ? (event) => pointerButton(event, false) : undefined
            }
            onPointerLeave={interactive ? pointerLeave : undefined}
            onPointerCancel={
              interactive ? endPointerUnexpectedly : undefined
            }
            onLostPointerCapture={
              interactive ? endPointerUnexpectedly : undefined
            }
            onWheel={interactive ? wheel : undefined}
            onKeyDown={interactive ? (event) => keyboard(event, true) : undefined}
            onKeyUp={interactive ? (event) => keyboard(event, false) : undefined}
            onBlur={
              interactive
                ? () => {
                    pointerInput.current.reset();
                    clearPendingPointerMove();
                    send({ kind: "releaseAll" });
                  }
                : undefined
            }
            onContextMenu={interactive ? (event) => event.preventDefault() : undefined}
          />
          {!session.frame && (
            <div className="remote-canvas__waiting">
              <span className="remote-canvas__pulse" aria-hidden="true">
                <ScreenShareIcon size={28} />
              </span>
              <strong>{t("remote.session.waitingTitle")}</strong>
              <span>{t("remote.session.waitingBody")}</span>
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  );
}
