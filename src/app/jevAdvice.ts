import type { MessageKey } from "../i18n/messages/zh-TW";

export const jevCategories = [
  "waiting_input", "login_required", "quota_limited", "update_required",
  "execution_error", "no_action", "unknown",
] as const;

export interface JevAdvice {
  category: typeof jevCategories[number];
  confidence: number;
  evidence: string | null;
  model: string;
  inputTokens: number;
}

/** Best-effort masking, followed by mandatory human review. Never an export guarantee. */
export function prepareJevPreview(raw: string): string {
  let text = raw
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  text = text.split("\n").map(line =>
    /(?:api[_ -]?key|authorization|bearer|password|secret|access[_ -]?token|refresh[_ -]?token)\s*[:= ]\s*\S/i.test(line)
      ? "[REDACTED]"
      : line
        .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{8,}/g, "[TOKEN]")
        .replace(/https?:\/\/[^\s"'<>]+/gi, "[URL]")
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[EMAIL]")
        .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[IP]")
        .replace(/[A-Za-z]:[\\/][^\s"'<>]+|\\\\[^\s"'<>]+/g, "[PATH]")
        .replace(/(?:\/[\w.@~-]+){2,}/g, "[PATH]")
  ).filter(line => line.trim()).slice(-40).map(line => [...line].slice(0, 200).join("")).join("\n");
  while (new TextEncoder().encode(text).length > 8_000) {
    text = text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : [...text].slice(1).join("");
  }
  return text;
}

export function validJevPreview(text: string): boolean {
  return text.trim().length > 0 && new TextEncoder().encode(text).length <= 8_000
    && text.split("\n").filter(line => line.trim()).length <= 40
    && !/[\x00-\x08\x0b-\x1f\x7f]/.test(text);
}

const errors = new Set([
  "internal", "key", "consent", "busy", "disabled", "input",
  "network", "auth", "billing", "rate", "response", "session",
]);

export function jevErrorKey(error: unknown): MessageKey {
  const name = String(error).replace(/^jev\.error\./, "");
  return errors.has(name) ? `jev.error.${name}` as MessageKey : "jev.error.internal";
}
