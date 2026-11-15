import { expect, it } from "vitest";
import { composerToken, insertProjectMention, shouldRecallPrompt } from "./composerAssistance";
it("finds only explicit command or file tokens at the caret", () => {
  expect(composerToken("/mo", 3)).toEqual({ kind: "command", query: "mo", start: 0, end: 3 });
  expect(composerToken("read @src/app then explain", 13)).toEqual({ kind: "file", query: "src/app", start: 5, end: 13 });
  for (const text of ["dev@example.com", "https://example.com/a", "please /review", "hello", "\\@literal"]) expect(composerToken(text, text.length)).toBeNull();
});
it("inserts a file reference at the caret without deleting the rest of the prompt", () => {
  const text = "read @src/app then explain";
  const result = insertProjectMention(text, composerToken(text, 13)!, "src/a b.ts");
  expect(result.text).toBe('read @"src/a b.ts"  then explain');
  expect(result.text.slice(result.caret)).toBe(" then explain");
});
it("recalls only into a completely empty composer and never consumes IME or modified keys", () => {
  expect(shouldRecallPrompt({ key: "ArrowUp" }, "", 0)).toBe(true);
  expect(shouldRecallPrompt({ key: "ArrowUp" }, "draft", 0)).toBe(false);
  expect(shouldRecallPrompt({ key: "ArrowUp" }, "", 1)).toBe(false);
  expect(shouldRecallPrompt({ key: "ArrowUp", ctrlKey: true }, "", 0)).toBe(false);
  expect(shouldRecallPrompt({ key: "ArrowUp", nativeEvent: { isComposing: true } }, "", 0)).toBe(false);
});
