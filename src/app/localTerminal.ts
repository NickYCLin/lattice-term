/**
 * The chat window's local shells. Output reaches the window as events; a
 * shell usually prints its prompt before the terminal view has subscribed,
 * so output for an id nobody listens to yet is held (bounded) and handed
 * over on the first subscription.
 */
import { decodeAgentPayload, encodeAgentPayload } from "./useAgentSessions";

interface DataEvent {
  terminalId: string;
  base64: string;
}

interface ExitEvent {
  terminalId: string;
  code: number | null;
}

const MAX_HELD_BYTES = 256 * 1024;

const dataHandlers = new Map<string, Set<(bytes: Uint8Array) => void>>();
const exitHandlers = new Map<string, Set<(code: number | null) => void>>();
const held = new Map<string, Uint8Array[]>();
const exited = new Map<string, number | null>();
let listening: Promise<void> | null = null;

function hold(id: string, bytes: Uint8Array) {
  const chunks = held.get(id) ?? [];
  chunks.push(bytes);
  let total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  while (total > MAX_HELD_BYTES && chunks.length > 1) total -= chunks.shift()!.length;
  held.set(id, chunks);
}

/** Starts listening once; safe to call before every open. */
export function ensureLocalTerminalEvents(): Promise<void> {
  listening ??= (async () => {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<DataEvent>("local-terminal-data", ({ payload }) => {
      const bytes = decodeAgentPayload(payload.base64);
      const handlers = dataHandlers.get(payload.terminalId);
      if (handlers?.size) handlers.forEach((handler) => handler(bytes));
      else hold(payload.terminalId, bytes);
    });
    await listen<ExitEvent>("local-terminal-exit", ({ payload }) => {
      exited.set(payload.terminalId, payload.code);
      exitHandlers.get(payload.terminalId)?.forEach((handler) => handler(payload.code));
    });
  })();
  return listening;
}

export function onLocalTerminalData(id: string, handler: (bytes: Uint8Array) => void): () => void {
  const handlers = dataHandlers.get(id) ?? new Set();
  handlers.add(handler);
  dataHandlers.set(id, handlers);
  const pending = held.get(id);
  if (pending) {
    held.delete(id);
    pending.forEach((bytes) => handler(bytes));
  }
  return () => handlers.delete(handler);
}

export function onLocalTerminalExit(id: string, handler: (code: number | null) => void): () => void {
  const handlers = exitHandlers.get(id) ?? new Set();
  handlers.add(handler);
  exitHandlers.set(id, handlers);
  if (exited.has(id)) handler(exited.get(id) ?? null);
  return () => handlers.delete(handler);
}

async function invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export async function openLocalTerminal(workingDirectory: string, cols = 80, rows = 24): Promise<string> {
  await ensureLocalTerminalEvents();
  return invoke<string>("local_terminal_open", {
    workingDirectory: workingDirectory || null,
    cols,
    rows,
  });
}

export function writeLocalTerminal(id: string, data: string): Promise<void> {
  return invoke("local_terminal_write", {
    terminalId: id,
    data: encodeAgentPayload(new TextEncoder().encode(data)),
  });
}

export function resizeLocalTerminal(id: string, cols: number, rows: number): Promise<void> {
  return invoke("local_terminal_resize", { terminalId: id, cols, rows });
}

export async function closeLocalTerminal(id: string): Promise<void> {
  dataHandlers.delete(id);
  exitHandlers.delete(id);
  held.delete(id);
  exited.delete(id);
  await invoke("local_terminal_close", { terminalId: id });
}
