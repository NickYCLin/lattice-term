import type { Terminal } from "@xterm/xterm";
import "./terminalScrollback.css";

export function attachTerminalScrollback(terminal: Terminal): () => void {
  const element = terminal.element;
  const update = () => {
    element?.classList.toggle(
      "has-scrollback",
      terminal.buffer.active.baseY > 0 &&
        terminal.options.scrollbar?.showScrollbar !== false,
    );
  };
  const parsed = terminal.onWriteParsed(update);
  const resized = terminal.onResize(update);
  update();
  return () => {
    parsed.dispose();
    resized.dispose();
    element?.classList.remove("has-scrollback");
  };
}
