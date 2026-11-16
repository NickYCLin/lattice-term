import { expect, it, vi } from "vitest";
import type { IBufferLine, ILink, Terminal } from "@xterm/xterm";
import { terminalImageLinks, attachTerminalImageClicks } from "./terminalImageLinks";

function fixture(text: string) {
  const cells = [...text].flatMap(character => /[\u3400-\u9fff]/.test(character)
    ? [{ text: character, width: 2 }, { text: "", width: 0 }]
    : [{ text: character, width: 1 }]);
  const line = { length: cells.length, translateToString: () => text,
    getCell: (column: number) => cells[column] && { getWidth: () => cells[column].width, getChars: () => cells[column].text } } as IBufferLine;
  return { buffer: { active: { getLine: (index: number) => index === 2 ? line : undefined } } } as Pick<Terminal, "buffer">;
}

it("passes one-based image numbers and wide-character line context", () => {
  const open = vi.fn();
  const provider = terminalImageLinks(fixture("中文 [Image #1] [Image #12]"), open);
  let links: ILink[] | undefined;
  provider.provideLinks(3, value => { links = value; });
  expect(links?.map(link => link.text)).toEqual(["[Image #1]", "[Image #12]"]);
  expect(links?.[0].range).toEqual({ start: { x: 6, y: 3 }, end: { x: 15, y: 3 } });
  links?.[0].activate({} as MouseEvent, "[Image #1]");
  links?.[1].activate({} as MouseEvent, "[Image #12]");
  expect(open).toHaveBeenNthCalledWith(1, expect.objectContaining({ index: 1, context: expect.stringContaining("中文 [Image #1]") }));
  expect(open).toHaveBeenNthCalledWith(2, expect.objectContaining({ index: 12 }));
});

it("ignores missing lines, ordinary text and invalid markers", () => {
  const callback = vi.fn();
  const open = vi.fn();
  const provider = terminalImageLinks(fixture("[Image #0] [Image #-1] [Image #] ordinary text"), open);
  provider.provideLinks(1, callback);
  expect(callback).toHaveBeenLastCalledWith(undefined);
  provider.provideLinks(3, callback);
  expect(callback).toHaveBeenLastCalledWith([]);
  expect(open).not.toHaveBeenCalled();
});

it("opens tool-observed image history from a Viewed image step without reading a terminal path", () => {
  const open = vi.fn();
  let links: ILink[] | undefined;
  terminalImageLinks(fixture("中文 Viewed image synthetic.png"), open).provideLinks(3, value => { links = value; });
  expect(links).toHaveLength(1);
  links![0].activate({} as MouseEvent, links![0].text);
  expect(open).toHaveBeenCalledOnce();
});

it("captures plain clicks before CLI mouse reporting and disposes its listeners", () => {
  const handlers = new Map<string, (event: MouseEvent) => void>();
  const element = {
    querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 50 }) }),
    addEventListener: vi.fn((type, handler) => handlers.set(type, handler)),
    removeEventListener: vi.fn(),
  };
  const terminal = fixture("[Image #2]") as Terminal;
  Object.assign(terminal.buffer.active, { viewportY: 2 });
  Object.assign(terminal, { element, cols: 20, rows: 5 });
  const open = vi.fn();
  const dispose = attachTerminalImageClicks(terminal, open);
  const event = { button: 0, clientX: 15, clientY: 5, shiftKey: false,
    preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() } as unknown as MouseEvent;
  handlers.get("mousedown")!(event);
  handlers.get("click")!(event);
  expect(open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ index: 2 }));
  expect(event.stopImmediatePropagation).toHaveBeenCalledTimes(2);
  handlers.get("click")!({ ...event, shiftKey: true } as MouseEvent);
  expect(open).toHaveBeenCalledOnce();
  dispose();
  expect(element.removeEventListener).toHaveBeenCalledWith("click", handlers.get("click"), true);
});
