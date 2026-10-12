import type { Terminal } from "@xterm/xterm";
import "./terminalScrollback.css";

export function attachTerminalScrollback(terminal: Terminal, refit?: () => void): () => void {
  const element = terminal.element;
  const update = () => {
    element?.classList.toggle("has-scrollbar", terminal.options.scrollbar?.showScrollbar !== false);
    element?.classList.toggle(
      "has-scrollback",
      terminal.buffer.active.baseY > 0 &&
        terminal.options.scrollbar?.showScrollbar !== false,
    );
  };
  const parsed = terminal.onWriteParsed(update);
  const resized = terminal.onResize(update);
  const scrolled = terminal.onScroll(update);
  const bufferChanged = terminal.buffer.onBufferChange(update);
  const rendered = terminal.onRender(() => {
    update();
    const screen = element?.querySelector(".xterm-screen")?.getBoundingClientRect();
    const scrollbar = element?.querySelector(".xterm-vertical")?.getBoundingClientRect();
    if (screen && scrollbar && scrollbar.width > 0 && screen.right > scrollbar.left) refit?.();
  });
  let disposed = false;
  const fontsChanged = () => { if (!disposed) refit?.(); };
  const fonts = typeof document === "undefined" ? undefined : document.fonts;
  fonts?.addEventListener("loadingdone", fontsChanged);
  void fonts?.ready.then(fontsChanged);
  update();
  return () => {
    parsed.dispose();
    resized.dispose();
    scrolled.dispose();
    bufferChanged.dispose();
    rendered.dispose();
    disposed = true;
    fonts?.removeEventListener("loadingdone", fontsChanged);
    element?.classList.remove("has-scrollback");
    element?.classList.remove("has-scrollbar");
  };
}
