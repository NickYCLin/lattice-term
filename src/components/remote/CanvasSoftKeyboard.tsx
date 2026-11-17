import { useEffect, useRef, useState } from "react";
import type {
  CompositionEvent,
  FormEvent,
  KeyboardEvent,
} from "react";
import { configurePlainTextInput } from "../../app/plainTextInput";
import { KeyboardIcon } from "../icons";

export type CanvasSoftKeyboardAction =
  | { kind: "text"; text: string }
  | { kind: "key"; key: "Backspace" | "Delete" | "Enter"; code: string };

export type CanvasTextToken =
  | { kind: "character"; character: string }
  | { kind: "key"; key: "Enter" | "Tab"; code: string };

type CanvasControlKey = "Backspace" | "Delete" | "Enter";

export const CANVAS_INPUT_SENTINEL = "\u200b";

export function isCanvasTextKey(key: string): boolean {
  return [...key].length === 1;
}

/** Browser placeholders emitted while an IME or dead-key composition starts. */
export function isCanvasImeKey(key: string, isComposing = false): boolean {
  return (
    isComposing ||
    key === "Process" ||
    key === "Dead" ||
    key === "Unidentified"
  );
}

/** Removes only the private leading sentinel, preserving intentional text. */
export function canvasInputText(value: string): string {
  return value.startsWith(CANVAS_INPUT_SENTINEL)
    ? value.slice(CANVAS_INPUT_SENTINEL.length)
    : value;
}

/** Converts a textarea input event into one remote-safe action. */
export function canvasSoftKeyboardAction(
  inputType: string,
  data: string | null,
  value: string,
  isComposing: boolean,
): CanvasSoftKeyboardAction | null {
  if (isComposing || inputType === "insertCompositionText") return null;
  if (inputType === "deleteContentBackward") {
    return { kind: "key", key: "Backspace", code: "Backspace" };
  }
  if (inputType === "deleteContentForward") {
    return { kind: "key", key: "Delete", code: "Delete" };
  }
  if (inputType === "insertLineBreak" || inputType === "insertParagraph") {
    return { kind: "key", key: "Enter", code: "Enter" };
  }
  const text = data ?? value;
  return text ? { kind: "text", text } : null;
}

/** Splits text into Unicode scalars while normalising control characters. */
export function canvasTextTokens(text: string): CanvasTextToken[] {
  return [...text.replace(/\r\n?/g, "\n")].map((character) => {
    if (character === "\n") {
      return { kind: "key", key: "Enter", code: "Enter" };
    }
    if (character === "\t") {
      return { kind: "key", key: "Tab", code: "Tab" };
    }
    return { kind: "character", character };
  });
}

export interface CanvasCompositionDecision {
  send: boolean;
  armSuppressionExpiry: boolean;
}

/**
 * Deduplicates the two legal IME commit orders: final input may arrive either
 * before or after compositionend, and a few WebViews emit both orders.
 */
export class CanvasCompositionFence {
  private active = false;
  private sentBeforeEnd: string | null = null;
  private pendingFallback: string | null = null;
  private suppressInput: string | null = null;

  begin() {
    this.reset();
    this.active = true;
  }

  input(text: string, isComposing: boolean): CanvasCompositionDecision {
    if (isComposing) return { send: false, armSuppressionExpiry: false };
    if (this.suppressInput === text) {
      this.suppressInput = null;
      return { send: false, armSuppressionExpiry: false };
    }
    this.suppressInput = null;
    if (this.active) {
      this.sentBeforeEnd = text;
      return { send: true, armSuppressionExpiry: false };
    }
    if (this.pendingFallback === text) {
      this.pendingFallback = null;
      this.suppressInput = text;
      return { send: true, armSuppressionExpiry: true };
    }
    return { send: true, armSuppressionExpiry: false };
  }

  end(text: string): { deferFallback: boolean; armSuppressionExpiry: boolean } {
    this.active = false;
    this.pendingFallback = null;
    if (this.sentBeforeEnd === text) {
      this.sentBeforeEnd = null;
      this.suppressInput = text;
      return { deferFallback: false, armSuppressionExpiry: true };
    }
    this.sentBeforeEnd = null;
    this.pendingFallback = text;
    return { deferFallback: true, armSuppressionExpiry: false };
  }

  fallback(text: string): CanvasCompositionDecision {
    if (this.pendingFallback !== text) {
      return { send: false, armSuppressionExpiry: false };
    }
    this.pendingFallback = null;
    this.suppressInput = text;
    return { send: true, armSuppressionExpiry: true };
  }

  clearSuppression() {
    this.suppressInput = null;
  }

  reset() {
    this.active = false;
    this.sentBeforeEnd = null;
    this.pendingFallback = null;
    this.suppressInput = null;
  }
}

/** Serialises press/release IPC so pasted text cannot reorder remotely. */
export class CanvasInputSequence {
  private tail: Promise<void> = Promise.resolve();

  enqueue(operation: () => Promise<unknown>) {
    this.tail = this.tail.then(operation).then(
      () => undefined,
      () => undefined,
    );
  }

  settled(): Promise<void> {
    return this.tail;
  }
}

/**
 * Deduplicates editing keys across keydown, beforeinput, and input. Mobile
 * engines emit different subsets of those events for the same key press.
 */
export class CanvasControlInputFence {
  private keyDownKey: CanvasControlKey | null = null;
  private pendingInputKey: CanvasControlKey | null = null;

  keyDown(key: CanvasControlKey) {
    this.keyDownKey = key;
    this.pendingInputKey = null;
  }

  beforeInput(key: CanvasControlKey): boolean {
    const sentByKeyDown = this.keyDownKey === key;
    this.keyDownKey = null;
    // A following input belongs to this beforeinput. A second beforeinput is a
    // new key repeat and must still be delivered even if both occur rapidly.
    this.pendingInputKey = key;
    return !sentByKeyDown;
  }

  input(key: CanvasControlKey): boolean {
    const alreadySent =
      this.pendingInputKey === key || this.keyDownKey === key;
    this.keyDownKey = null;
    this.pendingInputKey = null;
    return !alreadySent;
  }

  reset() {
    this.keyDownKey = null;
    this.pendingInputKey = null;
  }
}

export function CanvasSoftKeyboard({
  buttonLabel,
  closeButtonLabel,
  inputLabel,
  onText,
  onKeyTap,
  onReleaseAll,
}: {
  buttonLabel: string;
  closeButtonLabel: string;
  inputLabel: string;
  onText: (text: string) => void;
  onKeyTap: (key: string, code: string) => boolean;
  onReleaseAll: () => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    configurePlainTextInput(inputRef.current);
  }, []);

  const compositionFallback = useRef<number | null>(null);
  const suppressionExpiry = useRef<number | null>(null);
  const controlExpiry = useRef<number | null>(null);
  const compositionFence = useRef(new CanvasCompositionFence());
  const controlFence = useRef(new CanvasControlInputFence());
  const onTextRef = useRef(onText);
  const onKeyTapRef = useRef(onKeyTap);
  const [active, setActive] = useState(false);
  onTextRef.current = onText;
  onKeyTapRef.current = onKeyTap;

  function clearCompositionFallback() {
    if (compositionFallback.current === null) return;
    window.clearTimeout(compositionFallback.current);
    compositionFallback.current = null;
  }

  function clearSuppressionExpiry() {
    if (suppressionExpiry.current === null) return;
    window.clearTimeout(suppressionExpiry.current);
    suppressionExpiry.current = null;
  }

  function clearControlExpiry() {
    if (controlExpiry.current === null) return;
    window.clearTimeout(controlExpiry.current);
    controlExpiry.current = null;
  }

  function armControlExpiry() {
    clearControlExpiry();
    controlExpiry.current = window.setTimeout(() => {
      controlExpiry.current = null;
      controlFence.current.reset();
    }, 0);
  }

  function armSuppressionExpiry() {
    clearSuppressionExpiry();
    suppressionExpiry.current = window.setTimeout(() => {
      suppressionExpiry.current = null;
      compositionFence.current.clearSuppression();
    }, 100);
  }

  useEffect(
    () => () => {
      clearCompositionFallback();
      clearSuppressionExpiry();
      clearControlExpiry();
      compositionFence.current.reset();
      controlFence.current.reset();
    },
    [],
  );

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const listener = (event: Event) => {
      beforeInput(input, event as InputEvent);
    };
    // React's synthetic onBeforeInput does not consistently expose native
    // delete inputTypes, so listen on the real textarea. The sentinel-backed
    // onInput path remains the fallback for engines without beforeinput.
    input.addEventListener("beforeinput", listener);
    return () => input.removeEventListener("beforeinput", listener);
  }, []);

  function resetInput(input: HTMLTextAreaElement) {
    input.value = CANVAS_INPUT_SENTINEL;
    input.setSelectionRange(
      CANVAS_INPUT_SENTINEL.length,
      CANVAS_INPUT_SENTINEL.length,
    );
  }

  function dispatch(action: CanvasSoftKeyboardAction | null) {
    if (!action) return false;
    if (action.kind === "text") onTextRef.current(action.text);
    else onKeyTapRef.current(action.key, action.code);
    return true;
  }

  function input(event: FormEvent<HTMLTextAreaElement>) {
    const native = event.nativeEvent as InputEvent;
    const action = canvasSoftKeyboardAction(
      native.inputType ?? "",
      native.data ?? null,
      canvasInputText(event.currentTarget.value),
      native.isComposing ?? false,
    );
    if (!action) return;
    if (action.kind === "key") {
      const shouldSend = controlFence.current.input(action.key);
      clearControlExpiry();
      if (shouldSend) dispatch(action);
      resetInput(event.currentTarget);
      return;
    }
    if (action.kind === "text") {
      const decision = compositionFence.current.input(
        action.text,
        native.isComposing ?? false,
      );
      if (!decision.send) {
        resetInput(event.currentTarget);
        return;
      }
      if (decision.armSuppressionExpiry) armSuppressionExpiry();
    }
    clearCompositionFallback();
    dispatch(action);
    resetInput(event.currentTarget);
  }

  function beforeInput(input: HTMLTextAreaElement, native: InputEvent) {
    const action = canvasSoftKeyboardAction(
      native.inputType ?? "",
      native.data ?? null,
      canvasInputText(input.value),
      native.isComposing ?? false,
    );
    if (!action || action.kind !== "key") return;

    const shouldSend = controlFence.current.beforeInput(action.key);
    armControlExpiry();
    native.preventDefault();
    if (shouldSend) dispatch(action);
    resetInput(input);
  }

  function compositionEnd(event: CompositionEvent<HTMLTextAreaElement>) {
    clearCompositionFallback();
    const text = event.data;
    const decision = compositionFence.current.end(text);
    if (decision.armSuppressionExpiry) armSuppressionExpiry();
    if (!decision.deferFallback) {
      resetInput(event.currentTarget);
      return;
    }
    // Most engines send one final non-composing input event. Safari variants
    // that do not are covered by this next-task fallback without duplicating
    // the normal event.
    compositionFallback.current = window.setTimeout(() => {
      compositionFallback.current = null;
      const fallback = compositionFence.current.fallback(text);
      if (text && fallback.send) onTextRef.current(text);
      if (fallback.armSuppressionExpiry) armSuppressionExpiry();
      if (inputRef.current) resetInput(inputRef.current);
    }, 0);
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      isCanvasImeKey(event.key, event.nativeEvent.isComposing) ||
      isCanvasTextKey(event.key)
    ) {
      return;
    }
    if (!onKeyTap(event.key, event.code)) return;
    event.preventDefault();
    if (
      event.key === "Backspace" ||
      event.key === "Delete" ||
      event.key === "Enter"
    ) {
      controlFence.current.keyDown(event.key);
      armControlExpiry();
    }
    resetInput(event.currentTarget);
  }

  function toggleKeyboard() {
    if (active) inputRef.current?.blur();
    else inputRef.current?.focus({ preventScroll: true });
  }

  return (
    <span className="canvas-soft-keyboard">
      <button
        type="button"
        className={`capture-button canvas-soft-keyboard__toggle${active ? " is-active" : ""}`}
        aria-label={active ? closeButtonLabel : buttonLabel}
        aria-pressed={active}
        data-tooltip={active ? closeButtonLabel : buttonLabel}
        onPointerDown={(event) => {
          event.preventDefault();
          toggleKeyboard();
        }}
        onClick={(event) => {
          // Pointer activation already ran above so iOS sees focus inside the
          // original user gesture. detail=0 preserves keyboard/screen-reader
          // activation without toggling twice.
          if (event.detail === 0) toggleKeyboard();
        }}
      >
        <KeyboardIcon size={13} />
      </button>
      <textarea
        ref={inputRef}
        className="canvas-soft-keyboard__input"
        aria-label={inputLabel}
        defaultValue={CANVAS_INPUT_SENTINEL}
        rows={1}
        tabIndex={-1}
        inputMode="text"
        enterKeyHint="enter"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        onFocus={(event) => {
          setActive(true);
          resetInput(event.currentTarget);
        }}
        onBlur={() => {
          setActive(false);
          clearCompositionFallback();
          clearSuppressionExpiry();
          clearControlExpiry();
          compositionFence.current.reset();
          controlFence.current.reset();
          if (inputRef.current) resetInput(inputRef.current);
          onReleaseAll();
        }}
        onCompositionStart={() => {
          clearCompositionFallback();
          clearSuppressionExpiry();
          compositionFence.current.begin();
        }}
        onCompositionEnd={compositionEnd}
        onInput={input}
        onKeyDown={keyDown}
      />
    </span>
  );
}
