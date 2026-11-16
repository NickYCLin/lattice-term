import rules from "../security/transcriptRedaction.json";
import type { ImageConversation } from "./chatImagePreview";
export interface NativeRecord {
  id: string;
  turnId: string | null;
  messageId?: string | null;
  kind:
    | "user"
    | "assistant"
    | "reasoning"
    | "tool"
    | "fileChange"
    | "image"
    | "system"
    | "subagent";
  text: string;
  callId?: string;
  resultId?: string;
  name?: string;
  input?: string;
  output?: string;
  isError: boolean;
  unreadable: boolean;
}
export interface NativeHistoryCursor {
  before: number;
  length: number;
  modified: string;
}
export interface NativeRecordPage {
  diagnostics?: import("./nativeReadDiagnostics").NativeReadDiagnostics;
  turns: { id: string; items: NativeRecord[] }[];
  previousCursor: NativeHistoryCursor | null;
  truncated: boolean;
  warnings: string[];
}
export interface NativeRecordScope {
  threadId: string;
  workingDirectory: string;
  conversation: ImageConversation | null;
  agentId?: string | null;
}
const masks = rules.map((rule) => new RegExp(rule.pattern, rule.flags));
export function maskNativeText(text: string): string {
  return masks.reduce((value, rule) => value.replace(rule, "[REDACTED]"), text);
}
export function maskNativeValue<T>(input: T): T {
  let pem = false;
  function walk(value: unknown): unknown {
    if (typeof value === "string") {
      if (pem) {
        const end = value.search(/-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/);
        if (end < 0) return "[REDACTED]";
        pem = false;
        return (
          "[REDACTED]" +
          maskNativeText(
            value
              .slice(end)
              .replace(/^-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/, ""),
          )
        );
      }
      if (
        /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(value) &&
        !value.includes("-----END ")
      )
        pem = true;
      return maskNativeText(value);
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          /^(password|passwd|pwd|token|access_?token|refresh_?token|api[_-]?key|secret|client_?secret|authorization|aws_secret_access_key|private_?key)$/i.test(
            key,
          )
            ? "[REDACTED]"
            : walk(entry),
        ]),
      );
    return value;
  }
  return walk(input) as T;
}
