type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

type PendingInput = {
  data: string;
  matchedLength: number;
  fallbackDelivered: boolean;
  lateEchoes: string[];
  timer: TimerHandle;
  cleanupTimer?: TimerHandle;
};

type RecentData = {
  data: string;
  at: number;
};

const FALLBACK_DELAY_MS = 32;
const RECENT_DATA_WINDOW_MS = 100;
const LATE_DATA_WINDOW_MS = 250;
const COMMITTED_INPUT_TYPES = new Set(["insertText", "insertFromComposition"]);
const TERMINAL_COMMIT_SUFFIX = /^[\x00-\x20\x7f]{0,4}$/;

/**
 * Only WebKit (macOS WKWebView, Linux WebKitGTK) drops onData for some IME
 * commits, so only WebKit needs the fallback. Chromium (Windows WebView2) and
 * Gecko always emit onData for committed input — there, running the fallback
 * only risks a duplicate send when xterm's deferred composition onData lands
 * after our timer has already fired.
 */
function webkitImeFallbackNeeded(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /AppleWebKit/.test(ua) && !/(Chrome|Chromium|Edg)\//.test(ua);
}

/**
 * Repairs WebKit IME input shapes that update xterm's hidden textarea without
 * producing onData. Normal xterm input remains authoritative and consumes the
 * matching pending fallback before it can send a duplicate. On engines that do
 * not need it the fallback is inert, so onData is the only path that can send.
 */
export class TerminalImeFallback {
  private readonly pending: PendingInput[] = [];
  private readonly recent: RecentData[] = [];

  constructor(
    private readonly deliver: (data: string) => void,
    private readonly schedule: (
      task: () => void,
      delayMs: number,
    ) => TimerHandle = globalThis.setTimeout,
    private readonly cancel: (timer: TimerHandle) => void = globalThis.clearTimeout,
    private readonly now: () => number = Date.now,
    private readonly enabled: boolean = webkitImeFallbackNeeded(),
  ) {}

  /** Returns the part of an xterm data event that still needs forwarding. */
  recordTerminalData(data: string): string | null {
    if (!this.enabled) return data;

    this.trimRecent();
    let remaining = data;

    // A WebKitGTK composition may arrive after the fallback as one event,
    // several character events, or the committed text plus the space/enter
    // that selected it. Reconcile the stream by prefix instead of requiring
    // xterm and InputEvent to use identical event boundaries.
    while (remaining.length > 0) {
      const late = this.pending.find(
        (pending) =>
          pending.fallbackDelivered &&
          pending.lateEchoes.some(
            (echo) =>
              remaining.startsWith(echo) || echo.startsWith(remaining),
          ),
      );
      if (!late) break;

      const completedEcho = late.lateEchoes
        .filter((echo) => remaining.startsWith(echo))
        .sort((left, right) => right.length - left.length)[0];
      if (completedEcho !== undefined) {
        remaining = remaining.slice(completedEcho.length);
        this.removePending(late);
        continue;
      }

      late.lateEchoes = late.lateEchoes
        .filter((echo) => echo.startsWith(remaining))
        .map((echo) => echo.slice(remaining.length))
        .filter(Boolean);
      remaining = "";
    }

    if (!remaining) return null;

    this.matchUndelivered(remaining);
    this.recent.push({ data: remaining, at: this.now() });
    return remaining;
  }

  recordInput(data: string | null, inputType: string, isComposing = false) {
    if (!this.enabled) return;
    if (isComposing || !data || !COMMITTED_INPUT_TYPES.has(inputType)) return;

    this.trimRecent();
    const recentData = this.recent.map((candidate) => candidate.data).join("");
    const recentIndex = recentData.lastIndexOf(data);
    if (
      recentIndex >= 0 &&
      TERMINAL_COMMIT_SUFFIX.test(
        recentData.slice(recentIndex + data.length),
      )
    ) {
      // Space commonly commits a Chewing candidate. xterm can send the
      // committed phrase and that space before WebKit dispatches InputEvent,
      // so accept a short terminal-control suffix as the same commit.
      this.recent.length = 0;
      return;
    }

    const pending: PendingInput = {
      data,
      matchedLength: 0,
      fallbackDelivered: false,
      lateEchoes: [],
      timer: undefined as unknown as TimerHandle,
    };
    pending.timer = this.schedule(() => {
      this.deliverPending(pending);
    }, FALLBACK_DELAY_MS);
    this.pending.push(pending);
  }

  /** Preserve committed-text order before a mobile editing key is forwarded. */
  flushPending() {
    for (const pending of [...this.pending]) {
      if (!pending.fallbackDelivered) this.deliverPending(pending);
    }
  }

  private deliverPending(pending: PendingInput) {
    if (pending.fallbackDelivered || !this.pending.includes(pending)) return;
    this.cancel(pending.timer);
    const missing = pending.data.slice(pending.matchedLength);
    if (!missing) {
      this.removePending(pending);
      return;
    }
    pending.fallbackDelivered = true;
    // xterm may later replay either the complete composition or only the
    // suffix it had not emitted before the repair fired. Both are echoes of
    // bytes already delivered to the PTY by this point.
    pending.lateEchoes = [...new Set([pending.data, missing])];
    this.deliver(missing);
    // Keep the record briefly so a delayed xterm event can be identified.
    // It must eventually expire because an actual missing onData has nothing
    // left to match against.
    pending.cleanupTimer = this.schedule(() => {
      const index = this.pending.indexOf(pending);
      if (index >= 0) this.pending.splice(index, 1);
    }, LATE_DATA_WINDOW_MS);
  }

  dispose() {
    for (const pending of this.pending) {
      this.cancel(pending.timer);
      if (pending.cleanupTimer !== undefined) {
        this.cancel(pending.cleanupTimer);
      }
    }
    this.pending.length = 0;
    this.recent.length = 0;
  }

  private trimRecent() {
    const cutoff = this.now() - RECENT_DATA_WINDOW_MS;
    while (this.recent[0]?.at < cutoff) this.recent.shift();
  }

  private matchUndelivered(data: string) {
    let remaining = data;
    for (const pending of [...this.pending]) {
      if (pending.fallbackDelivered || !remaining) continue;
      const expected = pending.data.slice(pending.matchedLength);
      if (remaining.startsWith(expected)) {
        remaining = remaining.slice(expected.length);
        this.removePending(pending);
        continue;
      }
      if (expected.startsWith(remaining)) {
        pending.matchedLength += remaining.length;
      }
      break;
    }
  }

  private removePending(pending: PendingInput) {
    const index = this.pending.indexOf(pending);
    if (index >= 0) this.pending.splice(index, 1);
    this.cancel(pending.timer);
    if (pending.cleanupTimer !== undefined) {
      this.cancel(pending.cleanupTimer);
    }
  }
}
