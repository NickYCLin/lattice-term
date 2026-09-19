/**
 * Web pages a search or fetch tool reported, pulled out of its output so a
 * tool card can list them as sources.
 *
 * Every CLI words this differently: Claude Code appends a `Links: [...]`
 * JSON array to the WebSearch result, Gemini lists URLs in its text, and
 * Codex only reports the page it opened. The JSON list is read when present
 * for its titles; otherwise any http(s) address in the output counts.
 */

export interface WebSource {
  url: string;
  title: string;
}

const WEB_TOOLS = new Set([
  "WebSearch",
  "WebFetch",
  "web_search",
  "google_web_search",
  "web_fetch",
]);

const MAX_SOURCES = 20;
const TRUNCATION_MARK = "\n…";
const URL_PATTERN = /https?:\/\/[^\s<>"'`)\]}]+/g;

export function isWebTool(name: string): boolean {
  return WEB_TOOLS.has(name);
}

/** Only real web addresses are ever offered as links. */
function webUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** The JSON array after `Links:`, read up to its matching bracket. */
function linksArray(output: string): unknown[] | null {
  const marker = output.indexOf("Links:");
  if (marker < 0) return null;
  const start = output.indexOf("[", marker);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < output.length; index += 1) {
    const char = output[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(output.slice(start, index + 1));
          return Array.isArray(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function webSources(name: string, output: string | null): WebSource[] {
  if (!output || !isWebTool(name)) return [];
  const sources: WebSource[] = [];
  const seen = new Set<string>();
  const add = (url: string | null, title?: unknown) => {
    if (!url || seen.has(url) || sources.length >= MAX_SOURCES) return;
    seen.add(url);
    const label = typeof title === "string" ? title.trim() : "";
    sources.push({ url, title: label || hostOf(url) });
  };
  for (const entry of linksArray(output) ?? []) {
    if (entry && typeof entry === "object") {
      const { url, title } = entry as { url?: unknown; title?: unknown };
      add(webUrl(url), title);
    }
  }
  // The desktop cuts long tool output and marks the cut with "\n…"; an
  // address running into that mark is only part of one and would mislead.
  const cutAt = output.endsWith(TRUNCATION_MARK) ? output.length - TRUNCATION_MARK.length : -1;
  for (const match of output.matchAll(URL_PATTERN)) {
    if (match.index + match[0].length === cutAt) continue;
    // Sentences often end right after a link.
    add(webUrl(match[0].replace(/[.,;:!?]+$/, "")));
  }
  return sources;
}
