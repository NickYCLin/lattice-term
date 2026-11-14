import { useCallback, useLayoutEffect, useRef, type UIEvent, type WheelEvent } from "react";
import { isChatAtBottom } from "./chatScroll";

/** Follow changed layout, never an unchanged background snapshot. */
export function useChatScroll() {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const size = useRef<{ content: number; viewport: number } | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const next = { content: node.scrollHeight, viewport: node.clientHeight };
    const changed = !size.current || size.current.content !== next.content || size.current.viewport !== next.viewport;
    size.current = next;
    if (changed && pinned.current && !isChatAtBottom(node)) node.scrollTop = node.scrollHeight;
  });
  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    pinned.current = isChatAtBottom(event.currentTarget);
  }, []);
  const onWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    // Wheel intent arrives before the browser's asynchronous scroll event.
    // A simultaneous growing reply must not pull an upward scroll back down.
    if (event.deltaY < 0 && event.currentTarget.scrollHeight > event.currentTarget.clientHeight) pinned.current = false;
  }, []);
  const followBottom = useCallback(() => { pinned.current = true; size.current = null; }, []);
  return { ref, onScroll, onWheel, followBottom };
}
