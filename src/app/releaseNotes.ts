/**
 * Release notes arrive as the GitHub release body: Markdown written by
 * Release Please, with headings, bullet points, bold scopes and a link per
 * issue and per commit.  Shown raw, a person reads `**mcp**` and a 60
 * character commit URL instead of the sentence.  This turns that body into
 * the few things worth showing — section titles and one line per change —
 * with the Markdown removed and the commit links dropped, because a commit
 * hash means nothing to someone deciding whether to install.
 */

export interface ReleaseNoteSection {
  /** Heading text without its `#` markers; null for notes with no heading. */
  title: string | null;
  /** Bullet points, already flattened to plain text. */
  items: string[];
  /** Anything outside a list, kept so nothing silently disappears. */
  paragraphs: string[];
}

/** A `[abc1234](…/commit/…)` link: noise once the sentence is readable. */
const COMMIT_LINK = /\[`?[0-9a-f]{7,40}`?\]\(([^)]*\/commit\/[^)]*)\)/gi;
const MARKDOWN_LINK = /\[([^\]]*)\]\([^)]*\)/g;
const EMPHASIS = /(\*\*\*|\*\*|__|\*|_)(?=\S)([\s\S]*?\S)\1/g;

/** Markdown inline markup out, leaving the text a person would read. */
function plainText(markdown: string): string {
  let text = markdown.replace(COMMIT_LINK, "");
  text = text.replace(MARKDOWN_LINK, "$1");
  text = text.replace(/`([^`]*)`/g, "$1");
  // Emphasis can nest (`**a _b_**`), so run until nothing changes.
  for (let pass = 0; pass < 3; pass += 1) {
    const next = text.replace(EMPHASIS, "$2");
    if (next === text) break;
    text = next;
  }
  // Dropping a commit link leaves its parentheses and separators behind.
  text = text.replace(/\(\s*\)/g, "");
  text = text.replace(/\s+([,，、。])/g, "$1");
  text = text.replace(/([(（])\s+/g, "$1").replace(/\s+([)）])/g, "$1");
  text = text.replace(/[ \t]{2,}/g, " ");
  return text.replace(/^[\s,，]+|[\s,，]+$/g, "");
}

/**
 * Splits a release body into sections. Unknown Markdown (tables, quotes,
 * nested lists) is kept as a paragraph rather than dropped: better an odd
 * line than a missing one.
 */
export function parseReleaseNotes(body: string | null | undefined): ReleaseNoteSection[] {
  if (!body) return [];
  const sections: ReleaseNoteSection[] = [];

  const open = (title: string | null): ReleaseNoteSection => {
    const section: ReleaseNoteSection = { title, items: [], paragraphs: [] };
    sections.push(section);
    return section;
  };
  const current = () => sections[sections.length - 1] ?? open(null);

  for (const rawLine of body.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      const title = plainText(heading[1]);
      if (title) open(title);
      continue;
    }
    if (/^([-*_])\1{2,}$/.test(line)) continue; // A horizontal rule.

    const section = current();
    const bullet = /^[-*+]\s+(.*)$/.exec(line) ?? /^\d+[.)]\s+(.*)$/.exec(line);
    const text = plainText(bullet ? bullet[1] : line);
    if (!text) continue;
    if (bullet) section.items.push(text);
    else section.paragraphs.push(text);
  }

  return sections.filter(
    (section) => section.items.length > 0 || section.paragraphs.length > 0,
  );
}
