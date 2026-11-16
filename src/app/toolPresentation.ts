import type { ChatItem, ToolMeta } from "./agentChat";
import type { SessionConversationMessage } from "./useSessionConversation";

export interface CommandSummary { command: string; directory?: string }
export interface Exploration { files: number; searches: number; directories: number }
export interface ToolPresentation {
  id: string; aliases: string[]; name: string; input: string; output: string | null;
  done: boolean; isError: boolean; meta?: ToolMeta; images?: string[];
  commands: CommandSummary[]; exploration?: Exploration;
  raw: { name: string; input: string; output: string | null }[];
}
export interface PresentationRow<T> { id: string; aliases: string[]; value: T; tool?: ToolPresentation; commentary?: boolean }

type Token = { value: string; string?: boolean };
/** Tokenize a bounded JS subset, never execute CLI-provided code. */
function tokens(source: string): Token[] | null {
  if (source.length > 128_000) return null;
  const result: Token[] = [];
  for (let i = 0; i < source.length;) {
    const c = source[i];
    if (/\s/.test(c)) { i++; continue; }
    if (source.startsWith("//", i)) { const end = source.indexOf("\n", i); i = end < 0 ? source.length : end; continue; }
    if (source.startsWith("/*", i)) { const end = source.indexOf("*/", i + 2); if (end < 0) return null; i = end + 2; continue; }
    if (["'", '"', "`"].includes(c)) {
      let value = "", closed = false; i++;
      while (i < source.length) {
        let next = source[i++];
        if (next === c) { closed = true; break; }
        if (c === "`" && next === "$" && source[i] === "{") return null;
        if (next === "\\") {
          next = source[i++];
          if (next === undefined) return null;
          if (next === "u" || next === "x") {
            const size = next === "u" ? 4 : 2, hex = source.slice(i, i + size);
            if (!new RegExp(`^[0-9a-fA-F]{${size}}$`).test(hex)) return null;
            value += String.fromCharCode(parseInt(hex, 16)); i += size; continue;
          }
          const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" };
          if (next === "\n") continue;
          value += escapes[next] ?? next;
        } else value += next;
      }
      if (!closed) return null;
      result.push({ value, string: true }); continue;
    }
    if (c === "/") return null; // Regex literals and division are outside the static subset.
    const word = /^[\w$]+/.exec(source.slice(i));
    if (word) { result.push({ value: word[0] }); i += word[0].length; }
    else { result.push({ value: c }); i++; }
  }
  return result;
}

function staticFields(list: Token[], start: number): Record<string, string | string[]> | null {
  if (list[start]?.value !== "{") return null;
  let depth = 0; const result: Record<string, string | string[]> = {};
  for (let i = start + 1; i < list.length; i++) {
    const token = list[i];
    if (!depth && !token.string && token.value === "}") return result;
    if (!depth && !token.string && (token.value === "[" || token.value === ".")) return null;
    if (!depth && list[i + 1]?.value === ":") {
      delete result[token.value];
      const key = token.value, value = list[i + 2], end = list[i + 3];
      if (value?.string && [",", "}"].includes(end?.value)) result[key] = value.value;
      if (key === "session_id" && value && !value.string && /^\d+$/.test(value.value) && [",", "}"].includes(end?.value)) result[key] = value.value;
      if (value?.value === "[") {
        const parts: string[] = []; let j = i + 3;
        while (list[j]?.string && list[j + 1]?.value === ",") { parts.push(list[j].value); j += 2; }
        if (list[j]?.string) parts.push(list[j++].value);
        if (list[j]?.value === "]" && [",", "}"].includes(list[j + 1]?.value)) result[key] = parts;
      }
    }
    if (!token.string && ["{", "[", "("].includes(token.value)) depth++;
    if (!token.string && ["}", "]", ")"].includes(token.value)) depth--;
    if (depth < 0) return null;
  }
  return null;
}
function commandFields(value: Record<string, unknown>): CommandSummary | null {
  const command = value.cmd ?? value.command;
  // Array commands retain argument boundaries; do not pretend to evaluate expressions.
  const rendered = typeof command === "string" ? command : Array.isArray(command) && command.every(arg => typeof arg === "string")
    ? command.map(arg => /^[\w./:-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`).join(" ") : null;
  if (!rendered?.trim()) return null;
  const directory = value.workdir ?? value.cwd ?? value.working_directory;
  return { command: rendered, ...(typeof directory === "string" ? { directory } : {}) };
}
function baseName(name: string) { return name.split(/[./]/).slice(-1)[0]?.toLowerCase() ?? name.toLowerCase(); }
export function parseToolCommands(name: string, input: string): CommandSummary[] {
  const base = baseName(name);
  if (["exec_command", "shell", "shell_command", "run_shell_command", "bash", "commandexecution", "command"].includes(base)) {
    try {
      const value: unknown = JSON.parse(input);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const command = commandFields(value as Record<string, unknown>); if (command) return [command];
      }
      return [];
    } catch {
      // Native app-server summaries can already be plain shell text.
      if (input.trim() && !/^[{[]/.test(input.trim())) return [{ command: input }];
      return [];
    }
  }
  if (base !== "exec") return [];
  const list = tokens(input); if (!list) return [];
  if (list.some((token, index) => !token.string && (["if", "for", "while", "switch", "function", "try", "catch", "class", "?", "&", "|"].includes(token.value) || token.value === "=" && list[index + 1]?.value === ">"))) return [];
  const commands: CommandSummary[] = [];
  for (let i = 0; i < list.length - 4; i++) {
    if (list[i].string || list[i].value !== "tools") continue;
    if (list[i + 1].value !== "." || list[i + 2].value !== "exec_command" || list[i + 3].value !== "(") return [];
    const fields = staticFields(list, i + 4);
    const command = fields && commandFields(fields);
    if (!command) return []; // A dynamic call prevents a misleading partial summary.
    commands.push(command);
  }
  return commands;
}

/** Conservative allowlist: scripts, shell expansions and mutating flags are not exploration. */
export function commandExploration(command: string): Exploration | undefined {
  if (/[;&|><$`\n]/.test(command)) return;
  const name = command.trim().split(/\s+/)[0];
  const args = command.trim().split(/\s+/).slice(1);
  if (name === "ls" || name === "pwd" || name === "dir") return { files: 0, searches: 0, directories: 1 };
  if (["rg", "grep"].includes(name) && !args.some(arg => /^--(pre|hostname-bin|search-zip)/.test(arg))) return { files: 0, searches: 1, directories: 0 };
  if (name === "sed" && /^sed\s+-n\s+['"]?\d+(?:,\d+)?p['"]?\s+[\w./-]+$/.test(command.trim())) return { files: 1, searches: 0, directories: 0 };
  if (["head", "tail"].includes(name) && args.every(arg => /^[-\w./]+$/.test(arg))) {
    const files = args.filter(arg => !arg.startsWith("-") && !/^\d+$/.test(arg)).length;
    if (files) return { files, searches: 0, directories: 0 };
  }
  if (name === "cat" && args.length && args.every(arg => !arg.startsWith("-") && /^[\w./-]+$/.test(arg))) return { files: args.length, searches: 0, directories: 0 };
  return;
}
export function explorationFor(tool: Pick<ToolPresentation, "name" | "input" | "commands">): Exploration | undefined {
  if (tool.commands.length) {
    const counts = tool.commands.map(command => commandExploration(command.command));
    if (counts.every((count): count is Exploration => Boolean(count))) return counts.reduce((a, b) => ({ files: a.files + b.files, searches: a.searches + b.searches, directories: a.directories + b.directories }), { files: 0, searches: 0, directories: 0 });
    return;
  }
  const base = baseName(tool.name);
  if (["read", "read_file"].includes(base)) return { files: 1, searches: 0, directories: 0 };
  if (["list_directory", "list_dir"].includes(base)) return { files: 0, searches: 0, directories: 1 };
  if (["grep", "search", "glob"].includes(base)) return { files: 0, searches: 1, directories: 0 };
}
function reportedExit(output: string | null): number | undefined {
  const found = output?.match(/(?:"exit_code"\s*:\s*|Process exited with code\s+|(?:^|\n)Exit code:\s*)(-?\d+)/);
  return found ? Number(found[1]) : undefined;
}
export function presentTool(tool: Omit<ToolPresentation, "commands" | "raw">): ToolPresentation {
  const commands = parseToolCommands(tool.name, tool.input);
  const exitCode = tool.meta?.exitCode ?? reportedExit(tool.output);
  const model: ToolPresentation = { ...tool, commands, raw: [{ name: tool.name, input: tool.input, output: tool.output }],
    done: tool.done && tool.output !== null && !/Script running with cell ID|Script still running/.test(tool.output) && pendingKeys(tool.output).length === 0,
    isError: tool.isError || (exitCode !== undefined && exitCode !== 0) || /(?:^|\n)(?:Script (?:failed|error)|Error(?: executing)?[ :])|"is_?[Ee]rror"\s*:\s*true/.test(tool.output ?? ""),
    meta: { ...tool.meta, ...(exitCode !== undefined ? { exitCode } : {}) } };
  model.exploration = explorationFor(model); return model;
}
function validReference(id: unknown): string | undefined {
  const value = typeof id === "number" && Number.isSafeInteger(id) ? String(id) : typeof id === "string" ? id : "";
  return /^[\w-]{1,128}$/.test(value) ? value : undefined;
}
function pendingKeys(output: string | null): string[] {
  if (!output) return [];
  const keys: string[] = [];
  const cell = output.match(/Script (?:running|still running) with cell ID\s+([\w-]+)/)?.[1];
  if (cell) keys.push(`cell:${cell}`);
  const envelope = execEnvelope(output);
  const session = envelope && validReference(envelope.session_id);
  if (session && envelope?.exit_code == null) keys.push(`session:${session}`);
  return keys;
}
function waitCell(tool: ToolPresentation): string | undefined {
  const base = baseName(tool.name);
  let value: Record<string, unknown> | undefined;
  if (base === "wait" || base === "write_stdin") {
    try { const parsed: unknown = JSON.parse(tool.input); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed as Record<string, unknown>; } catch { return; }
    if (base === "wait") { const cell = validReference(value?.cell_id); return cell ? `cell:${cell}` : undefined; }
  } else if (base === "exec") {
    const list = tokens(tool.input); if (!list || list.some(token => !token.string && ["if", "for", "while", "switch", "function", "try", "catch", "class", "?", "&", "|", "="].includes(token.value))) return;
    const calls = list.flatMap((token, index) => !token.string && token.value === "tools" ? [index] : []);
    if (calls.length !== 1) return;
    const i = calls[0];
    if (list[i + 1]?.value !== "." || list[i + 2]?.value !== "write_stdin" || list[i + 3]?.value !== "(") return;
    const fields = staticFields(list, i + 4);
    // Dynamic stdin must remain a separate action, never mistaken for polling.
    if (!fields || fields.chars !== "") return;
    value = fields;
  }
  const session = validReference(value?.session_id);
  return session && (value?.chars === undefined || value.chars === "") ? `session:${session}` : undefined;
}
/** Only merge an explicit wait->cell reference within the same user turn. */
function mergeCells<T>(rows: PresentationRow<T>[], isUser: (value: T) => boolean): PresentationRow<T>[] {
  const cells = new Map<string, PresentationRow<T>>(); const result: PresentationRow<T>[] = [];
  for (const row of rows) {
    if (isUser(row.value)) cells.clear();
    const tool = row.tool;
    const cell = tool && waitCell(tool), owner = cell ? cells.get(cell) : undefined;
    if (owner?.tool && tool) {
      owner.aliases.push(...row.aliases); owner.tool.aliases = owner.aliases;
      owner.tool.raw.push(...tool.raw);
      owner.tool.output = [owner.tool.output, tool.output].filter(Boolean).join("\n\n");
      owner.tool.done = tool.done; owner.tool.isError ||= tool.isError;
      owner.tool.meta = { ...owner.tool.meta, ...tool.meta };
      owner.tool.images = [...(owner.tool.images ?? []), ...(tool.images ?? [])];
      cells.delete(cell!);
      for (const key of pendingKeys(tool.output)) cells.set(key, owner);
      continue;
    }
    result.push(row);
    if (tool?.commands.length) for (const key of pendingKeys(tool.output)) cells.set(key, row);
  }
  return result;
}
/** Only hide commentary separated from a later reply by a tool; keep the entire final text block. */
function markCommentary<T>(rows: PresentationRow<T>[], role: (value: T) => "user" | "text" | "other", text: (value: T) => string): PresentationRow<T>[] {
  let laterText = false, toolBeforeReply = false;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i], kind = role(row.value);
    if (kind === "user") { laterText = false; toolBeforeReply = false; continue; }
    if (row.tool && laterText) toolBeforeReply = true;
    if (kind === "text") {
      row.commentary = laterText && toolBeforeReply && !/[?？]|```|<image\b|data:image\/|!\[|\.(?:png|jpe?g|gif|webp)\b|(?:^|\n)(?:Error|錯誤|--- |\+\+\+ |@@ )/i.test(text(row.value));
      laterText = true;
    }
  }
  return rows;
}
export function chatToolRows(items: readonly ChatItem[]): PresentationRow<ChatItem>[] {
  return markCommentary(mergeCells(items.map(item => ({ id: item.id, aliases: [item.id], value: item,
    ...(item.type === "tool" ? { tool: presentTool({ ...item, input: item.summary, aliases: [item.id] }) } : {}) })), item => item.type === "user"), item => item.type === "user" ? "user" : item.type === "text" ? "text" : "other", item => "text" in item ? item.text : "");
}
export function sessionToolRows(messages: readonly SessionConversationMessage[]): PresentationRow<SessionConversationMessage>[] {
  const calls = new Map<string, number>(); const pairs = new Map<number, number[]>(); const consumed = new Set<number>();
  let turn = 0;
  const scopes = messages.map(message => { if (!message.tool && message.role === "user") turn++; return turn; });
  messages.forEach((message, index) => { if (message.tool?.kind === "call") calls.set(`${scopes[index]}:${message.tool.callId}`, index); });
  messages.forEach((message, index) => {
    if (message.tool?.kind === "result") {
      const owner = calls.get(`${scopes[index]}:${message.tool.callId}`);
      if (owner !== undefined) { pairs.set(owner, [...(pairs.get(owner) ?? []), index]); consumed.add(index); }
    }
  });
  const rows = messages.flatMap((message, index): PresentationRow<SessionConversationMessage>[] => {
    if (consumed.has(index)) return [];
    const results = pairs.get(index) ?? [], aliases = [index, ...results].map(String);
    return [{ id: String(message.renderId ?? index), aliases, value: message,
      ...(message.tool && message.tool.kind !== "reasoning" ? { tool: presentTool({ id: String(index), aliases, name: message.tool.name ?? "text", input: message.tool.kind === "call" ? message.text : "",
        output: message.tool.kind === "result" ? message.text : results.length ? results.map(index => messages[index].text).join("\n\n") : null,
        done: message.tool.kind === "result" || results.length > 0, isError: false }) } : {}) }];
  });
  return markCommentary(mergeCells(rows, message => !message.tool && message.role === "user"), message => message.tool ? "other" : message.role === "user" ? "user" : "text", message => message.text);
}
export function toolHasProtectedContent(tool: ToolPresentation): boolean {
  return (!tool.commands.length && !tool.exploration) || tool.isError || !tool.done || Boolean(tool.images?.length) || /(?:^|\n)(?:@@ |\+\+\+ |--- )|<image\b|data:image\/|\.(?:png|jpe?g|webp|gif)\b|(?:apply_patch|request_approval|user_input|elicitation|question)/i.test(`${tool.name}\n${tool.input}\n${tool.output ?? ""}\n${tool.raw.map(raw => raw.output === null ? "" : readableToolOutput(raw.output)).join("\n")}`);
}

function resultBody(raw: string): string {
  let body = raw;
  if (/^Script (?:completed|running with cell ID|still running)/.test(body)) {
    const marker = body.indexOf("\nOutput:\n");
    if (marker >= 0) body = body.slice(marker + "\nOutput:\n".length);
    else body = body.split("\n").filter(line => !/^Script (?:completed|running with cell ID|still running)|^Wall time:/.test(line)).join("\n");
  }
  return body;
}
function execEnvelope(raw: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(resultBody(raw));
    if (value && typeof value === "object" && "output" in value && typeof value.output === "string"
      && ("exit_code" in value || "chunk_id" in value || "session_id" in value)) return value as Record<string, unknown>;
  } catch { /* Unknown result shapes remain untouched. */ }
}
/** Decode known result envelopes for reading; raw payloads remain available. */
export function readableToolOutput(raw: string): string {
  return execEnvelope(raw)?.output as string | undefined ?? resultBody(raw);
}
