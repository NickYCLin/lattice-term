import { useLayoutEffect, useRef, useState } from "react";

/**
 * Whether a row of labelled tabs needs its compact form: only the selected
 * tab keeps its label, the others show their icon. Decided from the labels'
 * real widths, so it holds for every language and sidebar width.
 *
 * Each tab is a direct child of the returned element and holds its text in
 * a `.chat-mode__label`; compact labels stay in the DOM so their natural
 * width can still be measured when the room grows again.
 */
export function useFittingTabs<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [compact, setCompact] = useState(false);

  useLayoutEffect(() => {
    const list = ref.current;
    const container = list?.parentElement;
    if (!list || !container || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const style = getComputedStyle(container);
      const available = container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const listStyle = getComputedStyle(list);
      const tabs = Array.from(list.children) as HTMLElement[];
      const gap = parseFloat(listStyle.columnGap) || 0;
      let needed = parseFloat(listStyle.paddingLeft) + parseFloat(listStyle.paddingRight) + gap * (tabs.length - 1);
      for (const tab of tabs) {
        const label = tab.querySelector<HTMLElement>(".chat-mode__label");
        // A label narrowed by the compact form still reports its full width.
        needed += tab.offsetWidth - (label?.offsetWidth ?? 0) + (label?.scrollWidth ?? 0);
      }
      setCompact(needed > available + 0.5);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  });

  return { ref, compact };
}
