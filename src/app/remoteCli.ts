import type { RemoteChatResponse } from "./remoteChat";
export interface RemoteCliSession { id: string; label: string; groupLabel: string; agent: string; state: string; detached: boolean }
export interface RemoteCliOutput { sessionId: string; cursor: number; nextCursor: number; endOffset: number; truncated: boolean; base64: string }
export type RemoteCliOperation =
  | { kind: "cliList" }
  | { kind: "cliRead"; sessionId: string; cursor: number }
  | { kind: "cliInput"; sessionId: string; data: string }
  | { kind: "cliResize"; sessionId: string; cols: number; rows: number };
export async function requestRemoteCli<T>(connectionId: string, operation: RemoteCliOperation): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  const response = await invoke<RemoteChatResponse>("remote_chat_request", { sessionId: connectionId, request: { id: crypto.randomUUID(), operation } });
  if (response.error) throw new Error(response.error);
  return response.value as T;
}

/** One ordered write queue per mounted terminal. Uncertain writes are never retried. */
export class RemoteCliChannel {
  private active = true;
  private failed = false;
  private generation = 0;
  private pendingBytes = 0;
  private queue = Promise.resolve();
  private buffered = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly sessionId: string, private readonly request: (operation: RemoteCliOperation) => Promise<unknown>, private readonly onError: (error: unknown) => void) {}
  resume() { this.active = true; this.failed = false; }
  private enqueue(operation: RemoteCliOperation) {
    const generation = this.generation;
    const bytes = operation.kind === "cliInput" ? new TextEncoder().encode(operation.data).length : 0;
    this.pendingBytes += bytes;
    if (this.pendingBytes > 128 * 1024) { this.failed = true; this.onError(new Error("Too much pending input")); return; }
    this.queue = this.queue.then(async () => {
      if (!this.active || this.failed || generation !== this.generation) return;
      try { await this.request(operation); }
      catch (error) { if (this.active && generation === this.generation) { this.failed = true; this.buffered = ""; this.onError(error); } }
      finally { if (generation === this.generation) this.pendingBytes -= bytes; }
    });
  }
  input(data: string) {
    if (!this.active || this.failed) return;
    if (this.buffered.length + data.length > 128 * 1024) { this.failed = true; this.onError(new Error("Too much pending input")); return; }
    this.buffered += data;
    if (this.timer === undefined) this.timer = setTimeout(() => this.flush(), 30);
  }
  flush() {
    clearTimeout(this.timer); this.timer = undefined;
    // Include JSON escaping in the wire budget without splitting a Unicode code point.
    let chunk = "", length = 0;
    for (const character of this.buffered) {
      const size = new TextEncoder().encode(JSON.stringify(character)).length - 2;
      if (length + size > 16000) { this.enqueue({ kind: "cliInput", sessionId: this.sessionId, data: chunk }); chunk = ""; length = 0; }
      chunk += character; length += size;
    }
    this.buffered = "";
    if (chunk) this.enqueue({ kind: "cliInput", sessionId: this.sessionId, data: chunk });
  }
  resize(cols: number, rows: number) {
    this.flush();
    this.enqueue({ kind: "cliResize", sessionId: this.sessionId, cols: Math.max(2, Math.min(500, cols)), rows: Math.max(2, Math.min(300, rows)) });
  }
  stop() { this.generation++; this.pendingBytes = 0; this.active = false; this.buffered = ""; clearTimeout(this.timer); this.timer = undefined; }
}
