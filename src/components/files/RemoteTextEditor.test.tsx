import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { RemoteTextDocument } from "../../domain/remoteText";
import { REMOTE_TEXT_MAX_BYTES } from "../../domain/remoteText";
import { RemoteTextEditor, type RemoteTextEditorProps } from "./RemoteTextEditor";

const modal = vi.hoisted(() => ({ escape: null as (() => void) | null }));
const native = vi.hoisted(() => ({
  close: null as ((event: { preventDefault: () => void }) => void) | null,
  destroy: vi.fn(async () => {}),
  unlisten: vi.fn(),
  listen: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    destroy: native.destroy,
    onCloseRequested: (handler: typeof native.close) => {
      native.close = handler;
      return native.listen();
    },
  }),
}));
vi.mock("../overlays/modalFocus", () => ({
  useModalFocus: ({ onEscape }: { onEscape: () => void }) => { modal.escape = onEscape; },
}));
vi.mock("react-dom", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-dom")>(),
  createPortal: (children: unknown) => children,
}));

// The project has no browser-DOM test dependency. A small host tree lets React
// mount the real editor and update its event handlers/effects; browser focus
// trapping and layout remain covered separately by browser verification.
type HandlerProps = {
  onClick?: () => void;
  onChange?: (event: { currentTarget: { value: string } }) => void;
  onKeyDown?: (event: Record<string, unknown>) => void;
  onPaste?: (event: Record<string, unknown>) => void;
  disabled?: boolean;
  readOnly?: boolean;
  value?: string;
  role?: string;
};

class HostNode {
  nodeType = 1;
  namespaceURI = "http://www.w3.org/1999/xhtml";
  childNodes: HostNode[] = [];
  parentNode: HostNode | null = null;
  style = {};
  attributes: Record<string, string> = {};
  value = "";
  defaultValue = "";
  ownerDocument: Record<string, unknown>;
  private text = "";
  constructor(readonly tagName: string, document: Record<string, unknown>) {
    this.ownerDocument = document;
  }
  get nodeName() { return this.tagName; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get textContent(): string { return this.text + this.childNodes.map((child) => child.textContent).join(""); }
  set textContent(value: string) { this.text = value; this.childNodes = []; }
  appendChild(child: HostNode) { this.childNodes.push(child); child.parentNode = this; return child; }
  removeChild(child: HostNode) { this.childNodes = this.childNodes.filter((node) => node !== child); child.parentNode = null; return child; }
  insertBefore(child: HostNode, before: HostNode) { this.childNodes.splice(this.childNodes.indexOf(before), 0, child); child.parentNode = this; return child; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  setAttributeNS(_namespace: string, name: string, value: string) { this.setAttribute(name, value); }
  removeAttribute(name: string) { delete this.attributes[name]; }
  addEventListener() {}
  removeEventListener() {}
  focus() {}
}

function allNodes(node: HostNode): HostNode[] {
  return [node, ...node.childNodes.flatMap(allNodes)];
}

function props(node: HostNode): HandlerProps {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"))!;
  return (node as unknown as Record<string, HandlerProps>)[key];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const file = (content = "hello\n", revision = "revision-1"): RemoteTextDocument => ({
  path: "/notes.txt", content, revision,
});

describe("RemoteTextEditor render", () => {
  it.each(["en", "zh-TW"] as const)("renders a labelled modal and explicit scope in %s", (locale) => {
    const markup = renderToStaticMarkup(
      <I18nProvider locale={locale}><RemoteTextEditor path="/very/long/<script>.txt" read={vi.fn()} save={vi.fn()} onClose={vi.fn()} /></I18nProvider>,
    );
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain("&lt;script&gt;.txt");
    expect(markup).toContain("UTF-8");
    expect(markup).toContain("1 MiB");
    expect(markup).not.toContain("fileEditor.");
    expect(markup).not.toContain("<textarea");
    expect(markup).toContain(locale === "en" ? "backup" : "備份");
  });
});

describe("RemoteTextEditor interactions", () => {
  let root: Root;
  let host: HostNode;
  let current: RemoteTextEditorProps;
  const addWindowListener = vi.fn();
  const removeWindowListener = vi.fn();

  beforeEach(() => {
    const document: Record<string, unknown> = {
      nodeType: 9, activeElement: null,
      addEventListener() {}, removeEventListener() {},
    };
    document.createElement = (name: string) => new HostNode(name.toUpperCase(), document);
    document.createElementNS = (_namespace: string, name: string) => new HostNode(name.toUpperCase(), document);
    document.createTextNode = (text: string) => { const node = new HostNode("#text", document); node.nodeType = 3; node.textContent = text; return node; };
    host = new HostNode("DIV", document);
    document.body = host;
    document.documentElement = host;
    const window = { document, HTMLIFrameElement: class {}, addEventListener: addWindowListener, removeEventListener: removeWindowListener };
    document.defaultView = window;
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("HTMLElement", HostNode);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    addWindowListener.mockClear();
    removeWindowListener.mockClear();
    native.close = null;
    native.destroy.mockClear();
    native.unlisten.mockClear();
    native.listen.mockReset().mockResolvedValue(native.unlisten);
    root = createRoot(host as unknown as Element);
    current = { path: "/notes.txt", read: vi.fn(async () => file()), save: vi.fn(async (content) => file(content, "revision-2")), onClose: vi.fn() };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });

  async function render(patch: Partial<RemoteTextEditorProps> = {}) {
    current = { ...current, ...patch };
    await act(async () => root.render(<I18nProvider locale="en"><RemoteTextEditor {...current} /></I18nProvider>));
  }

  const textarea = () => allNodes(host).find((node) => node.tagName === "TEXTAREA")!;
  const button = (label: string) => allNodes(host).find((node) => node.tagName === "BUTTON" && node.textContent.includes(label))!;
  const edit = async (value: string) => { await act(async () => props(textarea()).onChange!({ currentTarget: { value } })); };
  const click = async (label: string) => { await act(async () => props(button(label)).onClick!()); };

  it("saves only changed text and retains BOM and CRLF with the exact revision", async () => {
    await render({ read: vi.fn(async () => file("\ufeffhello\r\n")) });
    expect(props(textarea()).value).toBe("hello\n");
    expect(props(button("Save")).disabled).toBe(true);
    await edit("hello!\n");
    expect(addWindowListener).toHaveBeenCalledWith("beforeunload", expect.any(Function));
    await click("Save");
    expect(current.save).toHaveBeenCalledExactlyOnceWith("\ufeffhello!\r\n", "revision-1", false);
    expect(props(textarea()).value).toBe("hello!\n");
    expect(host.textContent).toContain("Saved to remote host");
    expect(props(button("Save")).disabled).toBe(true);
    expect(removeWindowListener).toHaveBeenCalledWith("beforeunload", expect.any(Function));
  });

  it("keeps newer typing when a save finishes and advances its revision", async () => {
    const pending = deferred<RemoteTextDocument>();
    const save = vi.fn().mockReturnValueOnce(pending.promise).mockImplementation(async (content: string) => file(content, "revision-3"));
    await render({ save });
    await edit("first change\n");
    await click("Save");
    await edit("newer typing\n");
    await act(async () => pending.resolve(file("first change\n", "revision-2")));
    expect(props(textarea()).value).toBe("newer typing\n");
    expect(host.textContent).toContain("Unsaved changes");
    await click("Save");
    expect(save).toHaveBeenLastCalledWith("newer typing\n", "revision-2", false);
  });

  it("keeps the draft and revision after a rejected save instead of force-overwriting", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("Remote file changed")).mockImplementation(async (content: string) => file(content));
    await render({ save });
    await edit("my changes\n");
    await click("Save");
    expect(props(textarea()).value).toBe("my changes\n");
    expect(host.textContent).toContain("Remote file changed");
    expect(host.textContent).toContain("Your draft is still here");
    await click("Save");
    expect(save).toHaveBeenLastCalledWith("my changes\n", "revision-1", false);
  });

  it("confirms reload and closing dirty drafts in app, retaining the draft if reload fails", async () => {
    const read = vi.fn().mockResolvedValueOnce(file()).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(file("remote version\n"));
    await render({ read });
    await edit("my draft\n");
    await click("Reload");
    expect(read).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Discard unsaved changes?");
    await click("Keep editing");
    expect(props(textarea()).value).toBe("my draft\n");
    await click("Reload");
    await click("Discard and reload");
    expect(props(textarea()).value).toBe("my draft\n");
    expect(host.textContent).toContain("offline");
    await click("Retry reading");
    await click("Discard and reload");
    expect(props(textarea()).value).toBe("remote version\n");
    await edit("another draft");
    await act(async () => modal.escape!());
    expect(current.onClose).not.toHaveBeenCalled();
    await click("Discard and close");
    expect(current.onClose).toHaveBeenCalledOnce();
  });

  it("does not reload when callback identities change and ignores an unmounted read", async () => {
    await render();
    await edit("unsaved");
    const nextRead = vi.fn(async () => file("unwanted"));
    await render({ read: nextRead });
    expect(nextRead).not.toHaveBeenCalled();
    expect(props(textarea()).value).toBe("unsaved");
    const pending = deferred<RemoteTextDocument>();
    await render({ path: "/other.txt", read: () => pending.promise });
    await render({ path: "/third.txt", read: async () => file("third") });
    await act(async () => pending.resolve(file("stale")));
    expect(props(textarea()).value).toBe("third");
  });

  it("supports Ctrl/Cmd+S, prevents duplicate writes, and blocks close while saving", async () => {
    const pending = deferred<RemoteTextDocument>();
    await render({ save: vi.fn(() => pending.promise) });
    await edit("save me");
    const dialog = () => allNodes(host).find((node) => props(node)?.role === "dialog")!;
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    await act(async () => {
      for (const modifier of ["ctrlKey", "metaKey"]) props(dialog()).onKeyDown!({ key: "s", [modifier]: true, nativeEvent: {}, preventDefault, stopPropagation });
      modal.escape!();
    });
    expect(current.save).toHaveBeenCalledOnce();
    expect(current.onClose).not.toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve({ ...file("save me"), warning: "Review the original", backupPath: "/.notes.backup" }));
    expect(host.textContent).toContain("Review the original");
    expect(host.textContent).toContain("/.notes.backup");
  });

  it("allows retry after a first read failure and rejects unsupported content before editing", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(file("binary\0"));
    await render({ read });
    expect(textarea()).toBeUndefined();
    await click("Retry reading");
    expect(textarea()).toBeUndefined();
    expect(host.textContent).toContain("may be a binary file");
    expect(current.save).not.toHaveBeenCalled();
  });

  it("rejects an oversized paste as a whole instead of silently truncating the draft", async () => {
    await render();
    const preventDefault = vi.fn();
    await act(async () => props(textarea()).onPaste!({
      currentTarget: { selectionStart: 0, selectionEnd: 0 },
      clipboardData: { getData: () => "a".repeat(REMOTE_TEXT_MAX_BYTES) },
      preventDefault,
    }));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(props(textarea()).value).toBe("hello\n");
    expect(host.textContent).toContain("The pasted text was not inserted");
    expect(host.textContent).toContain("1 MiB editing limit");
    expect(current.save).not.toHaveBeenCalled();
  });

  it("guards native window closing with a distinct application-close confirmation", async () => {
    vi.stubGlobal("isTauri", true);
    await render();
    expect(props(textarea()).readOnly).toBe(false);
    await edit("unsaved native draft");
    const preventDefault = vi.fn();
    await act(async () => native.close!({ preventDefault }));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(native.destroy).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Discard the draft and close the application?");
    await click("Keep editing");
    expect(props(textarea()).value).toBe("unsaved native draft");
    await act(async () => native.close!({ preventDefault }));
    await click("Discard and close application");
    expect(native.destroy).toHaveBeenCalledOnce();
    expect(current.onClose).not.toHaveBeenCalled();
  });

  it("blocks native close while saving even after typing the original content back", async () => {
    vi.stubGlobal("isTauri", true);
    const pending = deferred<RemoteTextDocument>();
    await render({ save: vi.fn(() => pending.promise) });
    await edit("saving this");
    await click("Save");
    await edit("hello\n");
    const preventDefault = vi.fn();
    await act(async () => native.close!({ preventDefault }));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(native.destroy).not.toHaveBeenCalled();
    expect(host.textContent).toContain("A save is still in progress");
    await act(async () => pending.resolve(file("saving this", "revision-2")));
    expect(props(textarea()).value).toBe("hello\n");
    expect(host.textContent).not.toContain("A save is still in progress");
    expect(host.textContent).toContain("Unsaved changes");
  });

  it("keeps native editing read-only if the close safeguard cannot be registered", async () => {
    vi.stubGlobal("isTauri", true);
    native.listen.mockRejectedValueOnce(new Error("listener denied"));
    await render();
    expect(props(textarea()).readOnly).toBe(true);
    expect(host.textContent).toContain("Editing is disabled to protect unsaved work");
    expect(current.save).not.toHaveBeenCalled();
  });

  it("requires explicit access-risk confirmation before any SFTP save and keeps the draft on cancel", async () => {
    await render({ read: vi.fn(async () => ({ ...file(), requiresAccessConfirmation: true })) });
    await edit("shared file changes");
    await click("Save");
    expect(current.save).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Confirm this file's access-permission risk");
    expect(host.textContent).toContain("giving other accounts access");
    await click("Cancel");
    expect(current.save).not.toHaveBeenCalled();
    expect(props(textarea()).value).toBe("shared file changes");
    await click("Save");
    await click("Accept the risk and save");
    expect(current.save).toHaveBeenCalledExactlyOnceWith("shared file changes", "revision-1", true);
  });

  it("does not remember access-risk acceptance across saves", async () => {
    const save = vi.fn(async (content: string) => ({ ...file(content, "revision-2"), requiresAccessConfirmation: true }));
    await render({ read: vi.fn(async () => ({ ...file(), requiresAccessConfirmation: true })), save });
    await edit("first shared edit");
    await click("Save");
    await click("Accept the risk and save");
    await edit("second shared edit");
    await click("Save");
    expect(save).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Confirm this file's access-permission risk");
    await click("Accept the risk and save");
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith("second shared edit", "revision-2", true);
  });
});
