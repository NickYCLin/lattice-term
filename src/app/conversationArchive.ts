import type { NativeHistoryMessage } from "./agentChat";

export interface ArchivedConversation {
  definitionId: "codex" | "claude";
  title: string;
  messages: NativeHistoryMessage[];
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function content(value: unknown): string {
  if (typeof value === "string") return value.trim();
  const entry = object(value);
  if (entry) {
    if (typeof entry.type === "string" && !["text", "input_text", "output_text", "text_part"].includes(entry.type)) return "";
    if (typeof entry.text === "string") return entry.text.trim();
    if (Array.isArray(entry.parts)) return entry.parts.map(content).filter(Boolean).join("\n");
    if (Array.isArray(entry.content)) return entry.content.map(content).filter(Boolean).join("\n");
    return "";
  }
  return Array.isArray(value) ? value.map(content).filter(Boolean).join("\n") : "";
}

function parseMessages(rows: unknown): NativeHistoryMessage[] {
  if (!Array.isArray(rows)) return [];
  let totalBytes = 0;
  return rows.slice(-300).reverse().flatMap((row): NativeHistoryMessage[] => {
    const entry = object(row);
    if (!entry) return [];
    const author = object(entry.author);
    const sourceRole = entry.role ?? entry.sender ?? author?.role;
    const role = sourceRole === "human" ? "user" : sourceRole;
    if (role !== "user" && role !== "assistant") return [];
    const text = content(entry.text ?? entry.content ?? object(entry.message)?.content);
    const bounded = text.slice(0, 16 * 1024);
    totalBytes += bounded.length;
    return bounded && totalBytes <= 256 * 1024 ? [{ role, text: bounded }] : [];
  }).reverse();
}

function parseMapping(entry: Record<string, unknown>): NativeHistoryMessage[] {
  const mapping = object(entry.mapping);
  if (!mapping) return [];
  const nodes: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let current = typeof entry.current_node === "string" ? entry.current_node : "";
  while (current && !seen.has(current) && nodes.length < 3000) {
    seen.add(current);
    const node = object(mapping[current]);
    if (!node) break;
    if (object(node.message)) nodes.push(object(node.message)!);
    current = typeof node.parent === "string" ? node.parent : "";
  }
  // Exports without a current-node pointer still have a readable mapping.
  if (!nodes.length) for (const node of Object.values(mapping).slice(0, 3000)) {
    const message = object(object(node)?.message);
    if (message) nodes.push(message);
  }
  return parseMessages(nodes.reverse());
}

/** A user-selected export is reference material, not a live CLI session. */
export function parseConversationArchive(value: unknown): ArchivedConversation[] {
  const root = object(value);
  const rows = Array.isArray(value) ? value : root?.conversations;
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 100).flatMap((row): ArchivedConversation[] => {
    const entry = object(row);
    if (!entry) return [];
    const claude = Array.isArray(entry.chat_messages);
    const codex = Boolean(object(entry.mapping));
    const messages = codex ? parseMapping(entry) : parseMessages(claude ? entry.chat_messages : entry.messages);
    if (!messages.length) return [];
    const definitionId = claude ? "claude" : "codex";
    const title = typeof entry.title === "string" ? entry.title : typeof entry.name === "string" ? entry.name : messages[0].text;
    return [{ definitionId, title: title.trim().slice(0, 60), messages }];
  });
}
