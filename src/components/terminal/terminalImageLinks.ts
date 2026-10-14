import type { ILinkProvider, Terminal } from "@xterm/xterm";

export function terminalImageLinks(terminal: Pick<Terminal, "buffer">, openImages: () => void): ILinkProvider {
  return {
    provideLinks(lineNumber, callback) {
      const line = terminal.buffer.active.getLine(lineNumber - 1);
      if (!line) { callback(undefined); return; }
      const text = line.translateToString(true);
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
      callback([...text.matchAll(/\[Image #[1-9][0-9]*\]/g)].map(match => ({
        text: match[0],
        range: { start: { x: columnAt(match.index), y: lineNumber },
          end: { x: columnAt(match.index + match[0].length) - 1, y: lineNumber } },
        activate: () => openImages(),
      })));
    },
  };
}
