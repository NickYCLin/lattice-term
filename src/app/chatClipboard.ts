import { useEffect, useRef } from "react";
import { pasteContainsFiles, pasteContainsImage } from "./chatAttachments";

export function createChatClipboardFallback(readText: () => Promise<string | null>, paste: () => void) {
  let gesture = 0;
  let disposed = false;
  return {
    onKeyDown(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; repeat: boolean; isComposing: boolean }) {
      if (event.key.toLowerCase() !== "v" || !(event.ctrlKey || event.metaKey)
        || event.altKey || event.repeat || event.isComposing) return;
      const current = ++gesture;
      void readText().catch(() => null).then(text => {
        if (!disposed && current === gesture && !text) {
          paste();
        }
      });
    },
    onPaste(event: { clipboardData: DataTransfer; preventDefault: () => void }) {
      const items = event.clipboardData.items;
      if (pasteContainsImage(items) || pasteContainsFiles(items)) {
        gesture += 1;
        event.preventDefault();
        paste();
      } else if (event.clipboardData.getData("text/plain")) {
        gesture += 1;
      }
    },
    dispose() { disposed = true; },
  };
}

export function useChatClipboardFallback(scope: string, paste: () => void) {
  const pasteRef = useRef(paste);
  pasteRef.current = paste;
  const fallbackRef = useRef<ReturnType<typeof createChatClipboardFallback> | null>(null);
  useEffect(() => {
    const fallback = createChatClipboardFallback(async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<string | null>("terminal_clipboard_read_text");
    }, () => pasteRef.current());
    fallbackRef.current = fallback;
    return () => { fallback.dispose(); fallbackRef.current = null; };
  }, [scope]);
  return {
    onKeyDown: (event: Parameters<ReturnType<typeof createChatClipboardFallback>["onKeyDown"]>[0]) => fallbackRef.current?.onKeyDown(event),
    onPaste: (event: Parameters<ReturnType<typeof createChatClipboardFallback>["onPaste"]>[0]) => fallbackRef.current?.onPaste(event),
  };
}
