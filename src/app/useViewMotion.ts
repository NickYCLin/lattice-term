import { useEffect, useRef } from "react";
import type { MotionChoice } from "./preferences";

/** Animate the existing workspace; never remount a live terminal to animate it. */
export function useViewMotion(view: string, motion: MotionChoice) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (motion === "reduced" || (motion === "system" && media?.matches)) return;
    const animation = ref.current?.animate?.(
      [
        { opacity: 0.45, transform: "translateY(8px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 320, easing: "cubic-bezier(0.22, 0.68, 0.31, 1)" },
    );
    const onChange = () => {
      if (motion === "system" && media?.matches) animation?.cancel();
    };
    media?.addEventListener("change", onChange);
    return () => {
      animation?.cancel();
      media?.removeEventListener("change", onChange);
    };
  }, [view, motion]);
  return ref;
}
