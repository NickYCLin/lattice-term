type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

const DELETE = "\x7f";

/**
 * Phone keyboards are the only place this repair is needed. Desktop
 * keyboards always reach xterm through keydown/keypress, so leaving it off
 * there keeps the desktop input path exactly as xterm ships it.
 */
export function mobileKeyboardInputNeeded(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod/.test(ua)) return true;
  // iPadOS reports a desktop Safari user agent.
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
}

function unidentifiedKey(event: KeyboardEvent): boolean {
  return (
    event.keyCode === 229 ||
    event.key === "Unidentified" ||
    event.key === "Process"
  );
}

/**
 * Forwards committed soft-keyboard text that xterm would otherwise drop.
 *
 * Phone keyboards report Space, punctuation and often Backspace as a keydown
 * with keyCode 229 followed by an InputEvent. xterm ignores that `insertText`
 * because a keydown preceded it, and instead diffs its hidden textarea. That
 * diff loses the character, or sends a stray DEL when the textarea is cleared
 * after a composition ends. While no composition is active, this class takes
 * over those keys and sends the InputEvent data itself. Composition text
 * stays with xterm.
 */
export class MobileTerminalInput {
  private composing = false;
  private keyUnidentified = false;
  private keypressData: string | null = null;
  private readonly queue: string[] = [];
  private flushTimer?: TimerHandle;

  private readonly onKeyDown = (event: Event) => {
    this.keyUnidentified = unidentifiedKey(event as KeyboardEvent);
    this.keypressData = null;
  };
  private readonly onKeyPress = (event: Event) => {
    const keypress = event as KeyboardEvent;
    // Registered after xterm, so a cancelled keypress is one xterm sent.
    this.keypressData = keypress.defaultPrevented ? keypress.key : null;
  };
  private readonly onCompositionStart = () => {
    this.composing = true;
  };
  private readonly onCompositionEnd = () => {
    this.composing = false;
  };
  private readonly onBeforeInput = (event: Event) => {
    const input = event as InputEvent;
    if (input.isComposing || this.composing) return;
    const keyUnidentified = this.keyUnidentified;
    const keypressData = this.keypressData;
    this.keyUnidentified = false;
    this.keypressData = null;

    let data: string;
    if (input.inputType === "insertText" && input.data) {
      if (keypressData === input.data) return;
      data = input.data;
    } else if (input.inputType === "deleteContentBackward" && keyUnidentified) {
      data = DELETE;
    } else {
      return;
    }

    // Keep the hidden textarea unchanged so nothing else can resend it.
    input.preventDefault();
    this.queue.push(data);
    // xterm reads a just-finished composition in a zero-delay callback.
    // Waiting one turn keeps "word" ahead of the space that committed it.
    this.flushTimer ??= this.schedule(() => this.flush(), 0);
  };

  constructor(
    private readonly textarea: HTMLTextAreaElement | undefined,
    private readonly deliver: (data: string) => void,
    private readonly enabled: boolean = mobileKeyboardInputNeeded(),
    private readonly schedule: (
      task: () => void,
      delayMs: number,
    ) => TimerHandle = globalThis.setTimeout,
    private readonly cancel: (timer: TimerHandle) => void = globalThis.clearTimeout,
  ) {
    if (!enabled || !textarea) return;
    textarea.addEventListener("keydown", this.onKeyDown, true);
    textarea.addEventListener("keypress", this.onKeyPress, true);
    textarea.addEventListener("compositionstart", this.onCompositionStart);
    textarea.addEventListener("compositionend", this.onCompositionEnd);
    textarea.addEventListener("beforeinput", this.onBeforeInput);
  }

  /**
   * Keeps xterm's textarea diff away from keys this class forwards. Returning
   * false only for an unidentified keydown outside a composition leaves every
   * real key, and every IME candidate key, to xterm.
   */
  shouldProcessTerminalKeyEvent(event: KeyboardEvent): boolean {
    if (!this.enabled || !this.textarea) return true;
    if (event.type !== "keydown" || this.composing || event.isComposing) {
      return true;
    }
    return !unidentifiedKey(event);
  }

  dispose() {
    if (this.flushTimer !== undefined) {
      this.cancel(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.queue.length = 0;
    if (!this.enabled || !this.textarea) return;
    this.textarea.removeEventListener("keydown", this.onKeyDown, true);
    this.textarea.removeEventListener("keypress", this.onKeyPress, true);
    this.textarea.removeEventListener(
      "compositionstart",
      this.onCompositionStart,
    );
    this.textarea.removeEventListener("compositionend", this.onCompositionEnd);
    this.textarea.removeEventListener("beforeinput", this.onBeforeInput);
  }

  private flush() {
    this.flushTimer = undefined;
    const data = this.queue.join("");
    this.queue.length = 0;
    if (data) this.deliver(data);
  }
}