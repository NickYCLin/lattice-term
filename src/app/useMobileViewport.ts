import { useEffect } from "react";

/** The software keyboard can resize the visual viewport without changing vh. */
export function observeMobileViewport(win: Window, root: HTMLElement): () => void {
  const viewport = win.visualViewport;
  const properties = [
    "--app-viewport-height",
    "--app-viewport-top",
    "--app-viewport-width",
    "--app-viewport-left",
  ] as const;
  const previous = properties.map((name) => root.style.getPropertyValue(name));
  const previousKeyboard = root.getAttribute("data-mobile-keyboard");
  let frame: number | null = null;
  let revealFrame: number | null = null;
  const currentWidth = () => viewport?.width ?? win.innerWidth;
  const currentHeight = () => viewport?.height ?? win.innerHeight;
  let restWidth = currentWidth();
  let restHeight = currentHeight();
  let lastRevealKey = "";

  const expectedRest = (width: number, height: number) => {
    const screenW = Number(win.screen?.width);
    const screenH = Number(win.screen?.height);
    const short = Math.min(screenW, screenH);
    const long = Math.max(screenW, screenH);
    if (Number.isFinite(short) && Number.isFinite(long) && short > 0 && long > 0) {
      const landscape = width >= height;
      return { width: landscape ? long : short, height: landscape ? short : long };
    }
    return { width: restWidth, height: restHeight };
  };

  const revealFocusedField = () => {
    const focused = root.ownerDocument.activeElement as HTMLElement | null;
    if (!focused?.matches?.("input, textarea, [contenteditable='true']") || !focused.getBoundingClientRect) return;
    const visibleTop = viewport?.offsetTop ?? 0;
    const visibleLeft = viewport?.offsetLeft ?? 0;
    const visibleBottom = visibleTop + currentHeight();
    const visibleRight = visibleLeft + currentWidth();
    let clipTop = visibleTop;
    let clipBottom = visibleBottom;
    const clipLeft = visibleLeft;
    const clipRight = visibleRight;
    const body = focused.closest?.(".drawer__body") as HTMLElement | null;
    if (body?.getBoundingClientRect) {
      const bodyRect = body.getBoundingClientRect();
      clipTop = Math.max(clipTop, bodyRect.top);
      clipBottom = Math.min(clipBottom, bodyRect.bottom);
    }
    const drawer = focused.closest?.(".drawer") as HTMLElement | null;
    const foot = drawer?.querySelector?.(".drawer__foot") as HTMLElement | null;
    if (foot?.getBoundingClientRect) clipBottom = Math.min(clipBottom, foot.getBoundingClientRect().top);
    const fieldRect = focused.getBoundingClientRect();
    const verticallyVisible = fieldRect.bottom <= clipBottom - 8 && fieldRect.top >= clipTop + 8;
    const horizontallyVisible = fieldRect.right <= clipRight - 8 && fieldRect.left >= clipLeft + 8;
    if (verticallyVisible && horizontallyVisible) {
      lastRevealKey = "";
      return;
    }
    const revealKey = `${fieldRect.top}:${fieldRect.bottom}:${fieldRect.left}:${fieldRect.right}:${clipTop}:${clipBottom}:${clipLeft}:${clipRight}`;
    if (revealKey === lastRevealKey) return;
    lastRevealKey = revealKey;
    if (body) {
      if (fieldRect.bottom > clipBottom - 8) body.scrollTop += fieldRect.bottom - clipBottom + 8;
      else if (fieldRect.top < clipTop + 8) body.scrollTop += fieldRect.top - clipTop - 8;
    }
    focused.scrollIntoView?.({ block: "center", inline: "nearest" });
    const after = focused.getBoundingClientRect();
    if (body && after.bottom !== fieldRect.bottom && after.bottom > clipBottom - 8) {
      body.scrollTop += after.bottom - clipBottom + 8;
    }
  };

  const update = () => {
    frame = null;
    // Preserve pinch zoom: resizing the layout during magnification would
    // reflow the page under the user's fingers and fight accessibility zoom.
    if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
    const height = currentHeight();
    const width = currentWidth();
    if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(width) || width <= 0) return;
    const focused = root.ownerDocument.activeElement;
    const editing = Boolean(focused?.matches?.("input, textarea, [contenteditable='true']"));
    const rotated = width - restWidth > 80 && height < restHeight - 40;
    if (!editing || rotated) {
      restHeight = Math.max(height, win.innerHeight || height);
      restWidth = Math.max(width, win.innerWidth || width);
    } else {
      restHeight = Math.max(restHeight, height);
      restWidth = Math.max(restWidth, width);
    }
    const expected = expectedRest(width, height);
    // Keyboard may shrink height (portrait) or width (iPhone landscape side dock).
    const keyboardVisible = Boolean(
      editing && (expected.height - height > 80 || expected.width - width > 80),
    );
    root.style.setProperty("--app-viewport-height", `${height}px`);
    root.style.setProperty("--app-viewport-top", `${viewport?.offsetTop ?? 0}px`);
    root.style.setProperty("--app-viewport-width", `${width}px`);
    root.style.setProperty("--app-viewport-left", `${viewport?.offsetLeft ?? 0}px`);
    root.setAttribute("data-mobile-keyboard", String(keyboardVisible));
    if (keyboardVisible) {
      revealFocusedField();
      if (revealFrame === null) {
        revealFrame = win.requestAnimationFrame(() => {
          revealFrame = null;
          revealFocusedField();
        });
      }
    }
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
    if (revealFrame !== null) win.cancelAnimationFrame(revealFrame);
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
    if (!enabled) return;
    const stop = observeMobileViewport(window, document.documentElement);
    let cancelled = false;
    void import("@tauri-apps/api/core").then(({ invoke, isTauri }) => {
      if (!cancelled && isTauri()) return invoke("mobile_frontend_ready");
    }).catch((error: unknown) => console.warn("Cannot sync the native mobile viewport", error));
    return () => {
      cancelled = true;
      stop();
    };
  }, [enabled]);
}
