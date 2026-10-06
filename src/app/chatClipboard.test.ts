import { describe, expect, it, vi } from "vitest";
import { createChatClipboardFallback } from "./chatClipboard";

const shortcut = { key: "v", ctrlKey: true, metaKey: false, altKey: false, repeat: false, isComposing: false };
function pasteEvent(type: string, text = "") {
  return {
    clipboardData: { items: type ? [{ kind: type.startsWith("image/") ? "file" : "string", type }] : [], getData: () => text } as unknown as DataTransfer,
    preventDefault: vi.fn(),
  };
}

describe("chat clipboard native fallback", () => {
  it("reads an image when the webview never emits a paste event", async () => {
    const paste = vi.fn();
    const fallback = createChatClipboardFallback(async () => null, paste);
    fallback.onKeyDown(shortcut);
    await vi.waitFor(() => expect(paste).toHaveBeenCalledOnce());
  });

  it("leaves ordinary text paste to the textarea", async () => {
    const paste = vi.fn();
    const fallback = createChatClipboardFallback(async () => "hello", paste);
    const event = pasteEvent("text/plain", "hello");
    fallback.onKeyDown(shortcut);
    fallback.onPaste(event);
    await Promise.resolve();
    await Promise.resolve();
    expect(paste).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it.each(["image/png", "text/uri-list"])("does not duplicate a %s paste event", async type => {
    const paste = vi.fn();
    const fallback = createChatClipboardFallback(async () => null, paste);
    const event = pasteEvent(type);
    fallback.onKeyDown(shortcut);
    fallback.onPaste(event);
    await Promise.resolve();
    await Promise.resolve();
    expect(paste).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("supports repeated context-menu pastes", () => {
    const paste = vi.fn();
    const fallback = createChatClipboardFallback(async () => null, paste);
    fallback.onPaste(pasteEvent("image/png"));
    fallback.onPaste(pasteEvent("image/png"));
    expect(paste).toHaveBeenCalledTimes(2);
  });

  it("supports Command+V and an empty browser clipboard event", async () => {
    const paste = vi.fn();
    const fallback = createChatClipboardFallback(async () => null, paste);
    fallback.onKeyDown({ ...shortcut, ctrlKey: false, metaKey: true });
    fallback.onPaste(pasteEvent(""));
    await vi.waitFor(() => expect(paste).toHaveBeenCalledOnce());
  });

  it("tries native attachments when the native text read is unavailable", async () => {
    const paste = vi.fn();
    const fallback = createChatClipboardFallback(async () => { throw new Error("unavailable"); }, paste);
    fallback.onKeyDown(shortcut);
    await vi.waitFor(() => expect(paste).toHaveBeenCalledOnce());
  });

  it("ignores a stale probe after unmount or another paste gesture", async () => {
    let resolveText!: (text: string | null) => void;
    const paste = vi.fn();
    const fallback = createChatClipboardFallback(() => new Promise(resolve => { resolveText = resolve; }), paste);
    fallback.onKeyDown(shortcut);
    fallback.dispose();
    resolveText(null);
    await Promise.resolve();
    await Promise.resolve();
    expect(paste).not.toHaveBeenCalled();
  });

  it.each([{ altKey: true }, { repeat: true }, { isComposing: true }, { ctrlKey: false }])("ignores unrelated keystrokes %j", flags => {
    const read = vi.fn(async () => null);
    createChatClipboardFallback(read, vi.fn()).onKeyDown({ ...shortcut, ...flags });
    expect(read).not.toHaveBeenCalled();
  });
});
