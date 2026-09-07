import { useEffect } from "react";

/** The software keyboard can resize the visual viewport without changing vh. */
export function observeMobileViewport(win: Window, root: HTMLElement): () => void {
  const viewport = win.visualViewport;
  const properties = ["--app-viewport-height", "--app-viewport-top"] as const;
  const previous = properties.map((name) => root.style.getPropertyValue(name));
  const previousKeyboard = root.getAttribute("data-mobile-keyboard");
  let frame: number | null = null;

  const update = () => {
    frame = null;
    // Preserve pinch zoom: resizing the layout during magnification would
    // reflow the page under the user's fingers and fight accessibility zoom.
    if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
    const height = viewport?.height ?? win.innerHeight;
    if (!Number.isFinite(height) || height <= 0) return;
    root.style.setProperty("--app-viewport-height", `${height}px`);
    root.style.setProperty("--app-viewport-top", `${viewport?.offsetTop ?? 0}px`);
    const focused = root.ownerDocument.activeElement;
    const editing = focused?.matches("input, textarea, [contenteditable='true']");
    root.setAttribute(
      "data-mobile-keyboard",
      String(Boolean(editing && win.innerHeight - height > 100)),
    );
  };
  const schedule = () => {
    if (frame === null) frame = win.requestAnimationFrame(update);
  };
  viewport?.addEventListener("resize", schedule);
  viewport?.addEventListener("scroll", schedule);
  win.addEventListener("resize", schedule);
  root.addEventListener("focusin", schedule);
  root.addEventListener("focusout", schedule);
  update();

  return () => {
    viewport?.removeEventListener("resize", schedule);
    viewport?.removeEventListener("scroll", schedule);
    win.removeEventListener("resize", schedule);
    root.removeEventListener("focusin", schedule);
    root.removeEventListener("focusout", schedule);
    if (frame !== null) win.cancelAnimationFrame(frame);
    properties.forEach((name, index) => {
      if (previous[index]) root.style.setProperty(name, previous[index]);
      else root.style.removeProperty(name);
    });
    if (previousKeyboard === null) root.removeAttribute("data-mobile-keyboard");
    else root.setAttribute("data-mobile-keyboard", previousKeyboard);
  };
}

export function useMobileViewport(enabled: boolean): void {
  useEffect(() => {
    if (enabled) return observeMobileViewport(window, document.documentElement);
  }, [enabled]);
}
