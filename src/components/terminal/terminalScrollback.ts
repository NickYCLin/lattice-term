import type { Terminal } from "@xterm/xterm";
import "./terminalScrollback.css";

export function attachTerminalScrollback(terminal: Terminal, refit?: () => void, preferHistoryWheel = false): () => void {
  const element = terminal.element;
  let wheelRemainder = 0;
  const onWheel = (event: WheelEvent) => {
    if (!preferHistoryWheel || event.ctrlKey || event.altKey || event.deltaY === 0 ||
      terminal.buffer.active.type !== "normal" || terminal.buffer.active.baseY === 0) return;
    const screenHeight = element?.querySelector(".xterm-screen")?.getBoundingClientRect().height;
    if (!screenHeight || terminal.rows <= 0) return;
    const cellHeight = screenHeight / terminal.rows;
    const delta = event.deltaMode === 1 ? event.deltaY :
      event.deltaMode === 2 ? event.deltaY * terminal.rows : event.deltaY / cellHeight;
    if (Math.sign(delta) !== Math.sign(wheelRemainder)) wheelRemainder = 0;
    wheelRemainder += delta * (terminal.options.scrollSensitivity ?? 1) *
      (event.shiftKey ? terminal.options.fastScrollSensitivity ?? 5 : 1);
    const lines = Math.trunc(wheelRemainder);
    wheelRemainder -= lines;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (lines !== 0) terminal.scrollLines(lines);
  };
  element?.addEventListener("wheel", onWheel, { capture: true, passive: false });
  const update = () => {
    if (element) {
      element.dataset.terminalBuffer = terminal.buffer.active.type;
      element.dataset.terminalHistoryRows = String(terminal.buffer.active.baseY);
      element.dataset.terminalRows = String(terminal.rows);
      element.dataset.terminalCols = String(terminal.cols);
    }
    if (terminal.buffer.active.type !== "normal" || terminal.buffer.active.baseY === 0) wheelRemainder = 0;
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
    element?.removeEventListener("wheel", onWheel, true);
    fonts?.removeEventListener("loadingdone", fontsChanged);
    element?.classList.remove("has-scrollback");
    element?.classList.remove("has-scrollbar");
    if (element) {
      delete element.dataset.terminalBuffer;
      delete element.dataset.terminalHistoryRows;
      delete element.dataset.terminalRows;
      delete element.dataset.terminalCols;
    }
  };
}
