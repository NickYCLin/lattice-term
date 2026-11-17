import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../../i18n";
import type { RemoteSessionSummary } from "../../app/useRemoteSessions";
import { RemoteCommandPane, commandEnterInsertsNewline, shouldSubmitCommandOnEnter } from "./RemoteCommandPane";
const mock = vi.hoisted(() => ({ state: "running", stdout: "<script>unsafe()</script>中文", reconnectRequired: false }));
vi.mock("../../app/useRemoteCommand", () => ({
  commandActive: (view: { state: string }) => view.state === "running",
  useRemoteCommand: () => ({ ready: true, problem: null, start: vi.fn(), cancel: vi.fn(), view: { id: 1, state: mock.state, reconnectRequired: mock.reconnectRequired, command: "echo example", directory: "C:\\test", stdout: mock.stdout, stderr: "stderr marker", exitCode: mock.state === "running" || mock.reconnectRequired ? null : 7, detail: "" } }),
}));
function render(flags: number, hidden = false) {
  return renderToStaticMarkup(<I18nProvider locale="zh-TW"><RemoteCommandPane session={{ sessionId: "test", commandShells: flags } as RemoteSessionSummary} hidden={hidden} /></I18nProvider>);
}
describe("remote command panel", () => {
  it("distinguishes a missing result from confirmed failure or termination", () => {
    mock.state = "failed";
    mock.reconnectRequired = true;
    try {
      const markup = render(3);
      expect(markup).toContain("結果未確認");
      expect(markup).toContain("請先斷線再重新連線");
      expect(markup).not.toContain("結束代碼:");
      expect(markup).not.toContain(">停止</button>");
      expect(markup).toContain("&lt;script&gt;unsafe()&lt;/script&gt;中文");
    } finally { mock.reconnectRequired = false; }
  });
  it("shows only granted shells and renders output as text", () => {
    mock.state = "running";
    const markup = render(2);
    expect(markup).toContain('value="powerShell"');
    expect(markup).not.toContain('value="cmd"');
    expect(markup).toContain("&lt;script&gt;unsafe()&lt;/script&gt;中文");
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("停止");
    expect(markup).toContain("stderr marker");
  });
  it("offers POSIX only when independently advertised", () => {
    const markup = render(4);
    expect(markup).toContain('value="posix"');
    expect(markup).toContain("id; pwd");
    expect(markup).not.toContain('value="cmd"');
    expect(markup).not.toContain('value="powerShell"');
  });
  it("retains the result when hidden and shows a nonzero exit status", () => {
    mock.state = "exited";
    const markup = render(3, true);
    expect(markup).toContain('hidden=""');
    expect(markup).toContain("結束代碼: 7");
    expect(markup).toContain('value="cmd"');
    expect(markup).not.toContain(">停止</button>");
  });
  it("shows a send key hint and enterKeyHint=send on the command field", () => {
    mock.state = "exited";
    const markup = render(4);
    expect(markup).toContain("Enter 送出，Shift+Enter 換行");
    expect(markup.toLowerCase()).toContain("enterkeyhint");
    expect(markup.toLowerCase()).toContain("send");
    expect(markup).toContain("執行");
  });
});

describe("command field submit keys", () => {
  const enter = { key: "Enter", shiftKey: false };
  it("submits on Enter and keeps a newline on Shift+Enter", () => {
    expect(shouldSubmitCommandOnEnter(enter)).toBe(true);
    expect(shouldSubmitCommandOnEnter({ ...enter, shiftKey: true })).toBe(false);
  });
  it("does not submit on Enter when the field is in touch newline mode", () => {
    expect(shouldSubmitCommandOnEnter(enter, { enterInsertsNewline: true })).toBe(false);
    expect(shouldSubmitCommandOnEnter({ ...enter, shiftKey: true }, { enterInsertsNewline: true })).toBe(false);
  });
  it("does not submit while an IME is composing or with modifier keys", () => {
    expect(shouldSubmitCommandOnEnter({ ...enter, nativeEvent: { isComposing: true } })).toBe(false);
    expect(shouldSubmitCommandOnEnter({ ...enter, keyCode: 229 })).toBe(false);
    expect(shouldSubmitCommandOnEnter({ ...enter, nativeEvent: { isComposing: true } }, { enterInsertsNewline: false })).toBe(false);
    expect(shouldSubmitCommandOnEnter({ ...enter, keyCode: 229 }, { enterInsertsNewline: true })).toBe(false);
    expect(shouldSubmitCommandOnEnter({ ...enter, metaKey: true })).toBe(false);
    expect(shouldSubmitCommandOnEnter({ ...enter, ctrlKey: true })).toBe(false);
    expect(shouldSubmitCommandOnEnter({ ...enter, altKey: true })).toBe(false);
    expect(shouldSubmitCommandOnEnter({ key: "a", shiftKey: false })).toBe(false);
  });
});

describe("touch versus hardware Enter", () => {
  const env = (queries: string[], keyboard: boolean) => ({
    matches: (query: string) => queries.includes(query),
    onScreenKeyboardVisible: () => keyboard,
  });
  it("inserts a newline on a coarse-only phone even before the keyboard inset is published", () => {
    expect(commandEnterInsertsNewline(env(["(pointer: coarse)"], false))).toBe(true);
  });
  it("inserts a newline when a coarse device is showing the software keyboard", () => {
    expect(commandEnterInsertsNewline(env(["(pointer: coarse)", "(any-pointer: fine)"], true))).toBe(true);
  });
  it("keeps Enter-to-submit on a desktop fine pointer", () => {
    expect(commandEnterInsertsNewline(env(["(any-pointer: fine)"], false))).toBe(false);
  });
  it("keeps Enter-to-submit on a coarse device that also has a fine pointer and no software keyboard", () => {
    expect(commandEnterInsertsNewline(env(["(pointer: coarse)", "(any-pointer: fine)"], false))).toBe(false);
  });
});
