import { describe, expect, it } from "vitest";
import {
  prepareRemoteText,
  remoteTextByteLength,
  RemoteTextError,
  REMOTE_TEXT_MAX_BYTES,
  serializeRemoteText,
  type RemoteTextProblem,
} from "./remoteText";

function expectProblem(action: () => unknown, problem: RemoteTextProblem) {
  expect(action).toThrowError(RemoteTextError);
  try { action(); } catch (error) {
    expect((error as RemoteTextError).problem).toBe(problem);
  }
}

describe("remote text formatting", () => {
  it.each(["", "plain", "文字\n", "\ufeffhello\r\nworld\r\n", "a\tb\n", "🙂\n"])("round trips an unchanged draft without changing bytes: %j", (content) => {
    const buffer = prepareRemoteText(content);
    expect(serializeRemoteText(buffer, buffer.draft)).toBe(content);
  });

  it("hides the BOM in the editor and preserves it along with CRLF on save", () => {
    const buffer = prepareRemoteText("\ufeffhello\r\nworld\r\n");
    expect(buffer).toMatchObject({ draft: "hello\nworld\n", bom: true, lineEnding: "crlf" });
    expect(serializeRemoteText(buffer, "hello\n臺灣\n")).toBe("\ufeffhello\r\n臺灣\r\n");
    expect(serializeRemoteText(buffer, "hello\r\n臺灣\r\n")).toBe("\ufeffhello\r\n臺灣\r\n");
  });

  it("does not add a final newline or BOM to plain LF files", () => {
    expect(serializeRemoteText(prepareRemoteText("hello\nworld"), "hello\nworld!")).toBe("hello\nworld!");
  });

  it.each(["a\r\nb\n", "a\rb", "a\r\nb\r"])("refuses newline formats a textarea would silently change: %j", (content) => {
    expectProblem(() => prepareRemoteText(content), "unsupportedNewlines");
  });

  it.each(["\0", "\u001b", "\u007f", "\u0085", "\u000b"])("rejects binary/control text on read and save: %j", (content) => {
    expectProblem(() => prepareRemoteText(content), "binary");
    expectProblem(() => serializeRemoteText(prepareRemoteText(""), content), "binary");
  });

  it.each(["\ud800", "\udfff", "\ud800a", "\ud800\ud800"])("rejects malformed Unicode instead of letting TextEncoder replace it", (content) => {
    expectProblem(() => prepareRemoteText(content), "invalidUnicode");
    expectProblem(() => serializeRemoteText(prepareRemoteText(""), content), "invalidUnicode");
  });

  it("checks UTF-8 bytes, including BOM and restored CRLF, rather than character count", () => {
    const limit = "a".repeat(REMOTE_TEXT_MAX_BYTES);
    expect(prepareRemoteText(limit).draft.length).toBe(REMOTE_TEXT_MAX_BYTES);
    expectProblem(() => prepareRemoteText(`${limit}a`), "tooLarge");
    expectProblem(() => serializeRemoteText(prepareRemoteText(""), "界".repeat(REMOTE_TEXT_MAX_BYTES / 3 + 1)), "tooLarge");
    expectProblem(() => serializeRemoteText(prepareRemoteText("\ufeff\r\n"), `${limit}\n`), "tooLarge");
    expect(remoteTextByteLength("臺灣🙂")).toBe(10);
  });
});
