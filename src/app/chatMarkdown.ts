/**
 * A small Markdown reader for assistant replies.
 *
 * It covers what a coding agent actually writes — paragraphs, headings,
 * bullet and numbered lists, fenced code, inline code and bold — and turns
 * them into a block tree the view renders as React elements. There is no
 * HTML pass-through at all, so a reply can never inject markup; anything
 * this reader does not understand is shown as the text it was.
 */

export type InlineNode =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: InlineNode[] };

export type MarkdownBlock =
  | { type: "paragraph"; children: InlineNode[] }
  | { type: "heading"; level: number; children: InlineNode[] }
  | { type: "code"; language: string; text: string }
  | { type: "list"; ordered: boolean; items: InlineNode[][] };

const FENCE = /^\s*(```+|~~~+)\s*([A-Za-z0-9_+.#-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

const AGENT_METADATA = /(^|\n)[ \t]*<oai-mem-citation>[\s\S]*?(?:<\/oai-mem-citation>[ \t]*|$)/g;
const FENCED_SEGMENT = /(^|\n)[ \t]*(```+|~~~+)[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g;

/**
 * Removes bookkeeping blocks a CLI appends for its own client, such as
 * Codex memory citations, which are not meant to be read. Fenced code is
 * left untouched so a reply that explains the format still shows it.
 */
export function stripAgentMetadata(source: string): string {
  if (!source.includes("<oai-mem-citation>")) return source;
  let result = "";
  let last = 0;
  for (const match of source.matchAll(FENCED_SEGMENT)) {
    result += source.slice(last, match.index).replace(AGENT_METADATA, "$1");
    result += match[0];
    last = match.index + match[0].length;
  }
  result += source.slice(last).replace(AGENT_METADATA, "$1");
  return result.trimEnd();
}

export function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) nodes.push({ type: "text", text: buffer });
    buffer = "";
  };

  let index = 0;
  while (index < text.length) {
    if (text[index] === "`") {
      // A run of backticks opens a span closed by the same run.
      let run = 1;
      while (text[index + run] === "`") run += 1;
      const fence = "`".repeat(run);
      const close = text.indexOf(fence, index + run);
      if (close !== -1) {
        flush();
        nodes.push({ type: "code", text: text.slice(index + run, close) });
        index = close + run;
        continue;
      }
    }
    if (text.startsWith("**", index)) {
      const close = text.indexOf("**", index + 2);
      if (close > index + 2) {
        flush();
        nodes.push({
          type: "strong",
          children: parseInline(text.slice(index + 2, close)),
        });
        index = close + 2;
        continue;
      }
    }
    buffer += text[index];
    index += 1;
  }
  flush();
  return nodes;
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = stripAgentMetadata(source.replace(/\r\n?/g, "\n")).split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({
      type: "paragraph",
      children: parseInline(paragraph.join(" ")),
    });
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push({
      type: "list",
      ordered: list.ordered,
      items: list.items.map(parseInline),
    });
    list = null;
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph();
      flushList();
      const marker = fence[1];
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(marker)) {
        body.push(lines[index]);
        index += 1;
      }
      // An unterminated fence runs to the end: the code is still code.
      blocks.push({ type: "code", language: fence[2], text: body.join("\n") });
      index += 1;
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      flushList();
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({
        type: "heading",
        level: heading[1].length,
        children: parseInline(heading[2].trim()),
      });
      index += 1;
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((bullet ?? numbered)![1]);
      index += 1;
      continue;
    }

    if (list && /^\s{2,}/.test(line)) {
      // Indented continuation of the previous list item.
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      index += 1;
      continue;
    }

    flushList();
    paragraph.push(line.trim());
    index += 1;
  }
  flushParagraph();
  flushList();
  return blocks;
}
