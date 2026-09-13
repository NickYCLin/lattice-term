import { useEffect, useRef, useState, type DragEvent, type RefObject } from "react";

interface DropTarget {
  element: () => HTMLElement | null;
  enabled: () => boolean;
  highlight: (active: boolean) => void;
  paths: (paths: string[]) => void;
}
const targets = new Set<DropTarget>();
let stopNative: (() => void) | undefined;
let binding: Promise<void> | undefined;

/** One native listener, one visible hit target, including nested dialogs. */
export function pickDropTarget<T extends { element: () => HTMLElement | null; enabled: () => boolean }>(
  entries: Iterable<T>, hit: Element | null,
): T | undefined {
  if (!hit) return;
  let best: T | undefined;
  for (const entry of entries) {
    const node = entry.element();
    if (!node || !node.contains(hit)) continue;
    if (!best || best.element()!.contains(node)) best = entry;
  }
  return best?.enabled() ? best : undefined;
}
function clearHighlights() { for (const target of targets) target.highlight(false); }
function bindNative() {
  if (binding || stopNative) return;
  binding = (async () => {
    try {
      const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const stop = await getCurrentWebviewWindow().onDragDropEvent(({ payload }) => {
        clearHighlights();
        if (payload.type === "leave") return;
        const scale = window.devicePixelRatio || 1;
        const hit = document.elementFromPoint(payload.position.x / scale, payload.position.y / scale);
        const target = pickDropTarget(targets, hit);
        if (!target) return;
        if (payload.type === "drop") target.paths(payload.paths);
        else target.highlight(true);
      });
      if (targets.size) stopNative = stop;
      else stop();
    } catch { /* Browser preview uses DOM file drops below. */ }
    finally { binding = undefined; }
  })();
}

export function useFileDrop<T extends HTMLElement>({
  ref, disabled = false, onPaths, onFiles, onError,
}: {
  ref: RefObject<T | null>;
  disabled?: boolean;
  onPaths: (paths: string[]) => void | Promise<void>;
  onFiles?: (files: File[]) => void | Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const latest = useRef({ disabled, onPaths, onFiles, onError });
  latest.current = { disabled, onPaths, onFiles, onError };
  const busy = useRef(false);
  const run = async (action: () => void | Promise<void>) => {
    if (busy.current || latest.current.disabled) return;
    busy.current = true;
    try { await action(); } catch (error) { latest.current.onError(error); }
    finally { busy.current = false; }
  };
  useEffect(() => {
    const target: DropTarget = {
      element: () => ref.current,
      enabled: () => !latest.current.disabled && !busy.current,
      highlight: setDragging,
      paths: paths => { void run(() => latest.current.onPaths([...new Set(paths)])); },
    };
    targets.add(target); bindNative();
    return () => {
      targets.delete(target);
      if (!targets.size) { stopNative?.(); stopNative = undefined; }
    };
  }, [ref]);
  useEffect(() => { if (disabled) setDragging(false); }, [disabled]);
  const accepts = (event: DragEvent) => !latest.current.disabled && !!latest.current.onFiles && Array.from(event.dataTransfer.types).includes("Files");
  return {
    dragging,
    onDragOver: (event: DragEvent) => { if (accepts(event)) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "copy"; setDragging(true); } },
    onDragLeave: (event: DragEvent) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false); },
    onDrop: (event: DragEvent) => {
      // A disabled nested target must not upload through its parent or navigate.
      if (Array.from(event.dataTransfer.types).includes("Files")) {
        event.preventDefault(); event.stopPropagation(); setDragging(false);
      }
      if (!accepts(event)) return;
      event.preventDefault(); event.stopPropagation(); setDragging(false);
      const files = Array.from(event.dataTransfer.files);
      void run(() => latest.current.onFiles!(files));
    },
  };
}
