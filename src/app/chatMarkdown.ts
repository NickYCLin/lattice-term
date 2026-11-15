/** Removes CLI bookkeeping without treating a reply as trusted HTML. */

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

/** Only deliberate external links are opened; files use the scoped artifact handler. */
export function markdownLinkKind(value: string): "external" | "file" | "fragment" | null {
  if (!value || /[\x00-\x20\x7f]/.test(value)) return null;
  if (value.startsWith("#")) return "fragment";
  if (/^https?:\/\//i.test(value) || /^mailto:/i.test(value)) {
    try { const url = new URL(value); return url.protocol === "mailto:" || !!url.hostname ? "external" : null; }
    catch { return null; }
  }
  if (value.startsWith("//") || value.startsWith("\\\\")) return null;
  if (/^[a-z]:[\\/]/i.test(value) || !/^[a-z][a-z0-9+.-]*:/i.test(value)) return "file";
  return null;
}
