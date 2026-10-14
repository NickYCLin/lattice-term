import { expect, it, vi } from "vitest";
import type { IBufferLine, ILink, Terminal } from "@xterm/xterm";
import { terminalImageLinks } from "./terminalImageLinks";

function fixture(text: string) {
  const cells = [...text].flatMap(character => /[\u3400-\u9fff]/.test(character)
    ? [{ text: character, width: 2 }, { text: "", width: 0 }]
    : [{ text: character, width: 1 }]);
  const line = { length: cells.length, translateToString: () => text,
    getCell: (column: number) => cells[column] && { getWidth: () => cells[column].width, getChars: () => cells[column].text } } as IBufferLine;
  return { buffer: { active: { getLine: (index: number) => index === 2 ? line : undefined } } } as Pick<Terminal, "buffer">;
}

it("opens the existing session gallery for multiple markers, without claiming numbered image identity", () => {
  const open = vi.fn();
  const provider = terminalImageLinks(fixture("中文 [Image #1] [Image #12]"), open);
  let links: ILink[] | undefined;
  provider.provideLinks(3, value => { links = value; });
  expect(links?.map(link => link.text)).toEqual(["[Image #1]", "[Image #12]"]);
  expect(links?.[0].range).toEqual({ start: { x: 6, y: 3 }, end: { x: 15, y: 3 } });
  links?.[0].activate({} as MouseEvent, "[Image #1]");
  links?.[1].activate({} as MouseEvent, "[Image #12]");
  expect(open).toHaveBeenCalledTimes(2);
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
