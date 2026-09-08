/** Plain-text files stay in memory and retain their original UTF-8 format. */
export const REMOTE_TEXT_MAX_BYTES = 1024 * 1024;

export interface RemoteTextDocument {
  path: string;
  content: string;
  revision: string;
  warning?: string | null;
  backupPath?: string | null;
  /** SFTP cannot inspect ACLs for files readable by other accounts. */
  requiresAccessConfirmation?: boolean;
}

export type RemoteTextProblem = "tooLarge" | "binary" | "invalidUnicode" | "unsupportedNewlines";

export class RemoteTextError extends Error {
  constructor(readonly problem: RemoteTextProblem) {
    super(problem);
  }
}

export interface RemoteTextBuffer {
  original: string;
  draft: string;
  bom: boolean;
  lineEnding: "lf" | "crlf";
}

export function remoteTextByteLength(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}

function validateText(content: string): void {
  // TextEncoder replaces lone surrogates, which would silently corrupt a draft.
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = content.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new RemoteTextError("invalidUnicode");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new RemoteTextError("invalidUnicode");
    }
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(content)) {
    throw new RemoteTextError("binary");
  }
  if (remoteTextByteLength(content) > REMOTE_TEXT_MAX_BYTES) {
    throw new RemoteTextError("tooLarge");
  }
}

export function prepareRemoteText(content: string): RemoteTextBuffer {
  validateText(content);
  const bom = content.startsWith("\ufeff");
  const body = bom ? content.slice(1) : content;
  const withoutCrlf = body.replace(/\r\n/g, "");
  const hasCrlf = body.includes("\r\n");
  // A textarea normalizes line endings. Refuse formats we cannot round-trip
  // faithfully instead of changing unrelated lines when saving a small edit.
  if (withoutCrlf.includes("\r") || (hasCrlf && withoutCrlf.includes("\n"))) {
    throw new RemoteTextError("unsupportedNewlines");
  }
  return {
    original: content,
    draft: body.replace(/\r\n/g, "\n"),
    bom,
    lineEnding: hasCrlf ? "crlf" : "lf",
  };
}

export function serializeRemoteText(buffer: RemoteTextBuffer, draft: string): string {
  const normalized = draft.replace(/\r\n?/g, "\n");
  if (normalized === buffer.draft) return buffer.original;
  const body = buffer.lineEnding === "crlf" ? normalized.replace(/\n/g, "\r\n") : normalized;
  const content = (buffer.bom ? "\ufeff" : "") + body;
  validateText(content);
  return content;
}
