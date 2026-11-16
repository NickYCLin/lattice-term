import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";

export interface TerminalImageReference { index?: number; context: string }
export function terminalImageLinks(terminal: Pick<Terminal, "buffer">, openImages: (reference: TerminalImageReference) => void): ILinkProvider {
  return {
    provideLinks(lineNumber, callback) {
      const line = terminal.buffer.active.getLine(lineNumber - 1);
      if (!line) { callback(undefined); return; }
      const text = line.translateToString(true);
      const context = Array.from({ length: 7 }, (_, i) => terminal.buffer.active.getLine(lineNumber - 4 + i)?.translateToString(true) ?? "").join("\n").slice(0, 4096);
      const columnAt = (offset: number) => {
        let characters = 0;
        for (let column = 0; column < line.length; column++) {
          const cell = line.getCell(column);
          if (!cell || cell.getWidth() === 0) continue;
          if (characters >= offset) return column + 1;
          characters += cell.getChars().length || 1;
        }
        return line.length + 1;
      };
      callback([...text.matchAll(/\[Image #([1-9][0-9]*)\]|Viewed image[^\r\n]*/g)].map(match => ({
        text: match[0],
        range: { start: { x: columnAt(match.index), y: lineNumber },
          end: { x: columnAt(match.index + match[0].length) - 1, y: lineNumber } },
        activate: () => openImages({ index: match[1] && Number.isSafeInteger(Number(match[1])) ? Number(match[1]) : undefined, context }),
      })));
    },
  };
}

/** Capture image clicks before a full-screen CLI's mouse reporting consumes them.
 * Shift-click remains available for terminal text selection. */
export function attachTerminalImageClicks(terminal: Terminal, openImages: (reference: TerminalImageReference) => void): () => void {
  const element = terminal.element;
  if (!element) return () => {};
  const provider = terminalImageLinks(terminal, openImages);
  const hit = (event: MouseEvent): ILink | undefined => {
    if (event.button !== 0 || event.shiftKey) return;
    const rect = element.querySelector(".xterm-screen")?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return;
    const x = Math.floor((event.clientX - rect.left) * terminal.cols / rect.width) + 1;
    const row = Math.floor((event.clientY - rect.top) * terminal.rows / rect.height);
    if (x < 1 || x > terminal.cols || row < 0 || row >= terminal.rows) return;
    const y = terminal.buffer.active.viewportY + row + 1;
    let found: ILink | undefined;
    provider.provideLinks(y, links => { found = links?.find(link => x >= link.range.start.x && x <= link.range.end.x); });
    return found;
  };
  const down = (event: MouseEvent) => { if (hit(event)) { event.preventDefault(); event.stopImmediatePropagation(); } };
  const click = (event: MouseEvent) => {
    const link = hit(event);
    if (link) { event.preventDefault(); event.stopImmediatePropagation(); link.activate(event, link.text); }
  };
  element.addEventListener("mousedown", down, true);
  element.addEventListener("mouseup", down, true);
  element.addEventListener("click", click, true);
  return () => { element.removeEventListener("mousedown", down, true); element.removeEventListener("mouseup", down, true); element.removeEventListener("click", click, true); };
}
