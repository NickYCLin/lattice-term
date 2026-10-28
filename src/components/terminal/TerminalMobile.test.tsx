import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SshApi } from "../../app/useSshSessions";
import type { RemoteApi, RemoteSessionSummary } from "../../app/useRemoteSessions";
import { I18nProvider } from "../../i18n";
import { allNodes, installHostDom, props, type HostNode } from "../agents/testFixtures/interactionDom";
import { RemoteTerminalView } from "../remote/RemoteTerminalView";
import { TerminalPane } from "./TerminalPane";

const mocks = vi.hoisted(() => ({ terminals: [] as any[] }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  textarea = Object.assign(new EventTarget(), { value: "" });
  options: Record<string, unknown>;
  keyHandler: (event: KeyboardEvent) => boolean = () => true;
  dataHandler: (data: string) => void = () => {};
  constructor(options: Record<string, unknown>) { this.options = options; mocks.terminals.push(this); }
  open() {}
  loadAddon() {}
  onData(handler: (data: string) => void) { this.dataHandler = handler; return { dispose() {} }; }
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) { this.keyHandler = handler; }
  input(data: string) { this.dataHandler(data); }
  write() {}
  focus() {}
  blur() {}
  dispose() {}
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("../../app/typography", () => ({ attachTerminalTypography: () => () => {} }));
vi.mock("./terminalScrollback", () => ({ attachTerminalScrollback: () => () => {} }));
vi.mock("./terminalImePresentation", () => ({ TerminalImePresentation: class {
  shouldProcessTerminalKeyEvent() { return true; }
  dispose() {}
} }));
vi.mock("./terminalTheme", () => ({ TERMINAL_LETTER_SPACING: 0, terminalFontFamily: () => "monospace", terminalTheme: () => ({}) }));

let container: HostNode;
let root: ReturnType<typeof createRoot>;
const send = vi.fn(async () => {});
const ssh = { send, resize: vi.fn(async () => {}), onData: () => () => {}, onClosed: () => () => {} } as unknown as SshApi;
const remote = { terminalInput: send, terminalResize: vi.fn(async () => {}), onTerminalData: () => () => {} } as unknown as RemoteApi;
const session: RemoteSessionSummary = {
  sessionId: "mobile-terminal", profileId: "test-profile", host: "example.invalid", port: 1234, viaRelay: false,
  agentName: "test", width: 80, height: 24, viewOnly: false, fileTransfer: false,
  fileRootLabel: "", terminal: true, frame: null,
};

beforeEach(() => {
  vi.useFakeTimers();
  container = installHostDom();
  root = createRoot(container as unknown as Element);
  vi.stubGlobal("navigator", { userAgent: "Android", maxTouchPoints: 1 });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(async () => {
  await act(async () => root.unmount());
  mocks.terminals.length = 0;
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function render(kind: string, viewOnly = false, inputDisabled = false) {
  await act(async () => root.render(<I18nProvider locale="zh-TW">
    {kind === "ssh"
      ? <TerminalPane sessionId="mobile-terminal" ssh={ssh} theme="dark" mobile onClosed={() => {}} />
      : <RemoteTerminalView session={{ ...session, viewOnly }} remote={remote} theme="dark" inputDisabled={inputDisabled} />}
  </I18nProvider>));
  return mocks.terminals[mocks.terminals.length - 1]!;
}

function softKey(terminal: any, data: string | null, inputType = "insertText") {
  const key = Object.assign(new Event("keydown", { cancelable: true }), { key: "Unidentified", keyCode: 229 });
  expect(terminal.keyHandler(key)).toBe(false);
  terminal.textarea.dispatchEvent(key);
  const input = Object.assign(new Event("beforeinput", { cancelable: true }), { inputType, data, isComposing: false });
  terminal.textarea.dispatchEvent(input);
  expect(input.defaultPrevented).toBe(true);
}

describe.each(["ssh", "remote"])("%s mobile terminal", kind => {
  it("forwards soft-keyboard spaces, punctuation and deletion once", async () => {
    const terminal = await render(kind);
    softKey(terminal, " ");
    softKey(terminal, "!");
    await act(async () => vi.runAllTimers());
    expect(send).toHaveBeenCalledExactlyOnceWith("mobile-terminal", " !");
    softKey(terminal, null, "deleteContentBackward");
    await act(async () => vi.runAllTimers());
    expect(send).toHaveBeenLastCalledWith("mobile-terminal", "\x7f");
  });

  it("offers touch controls and applies Ctrl once to actual terminal input", async () => {
    const terminal = await render(kind);
    const ctrl = allNodes(container).find(node => props(node)?.["aria-pressed"] === false)!;
    await act(async () => props(ctrl).onClick());
    await act(async () => { terminal.input("c"); terminal.input("c"); });
    expect(send.mock.calls.map(call => call.slice(1))).toEqual([["\x03"], ["c"]]);
    const home = allNodes(container).find(node => node.tagName === "BUTTON" && node.textContent === "Home")!;
    await act(async () => props(home).onClick());
    expect(send).toHaveBeenLastCalledWith("mobile-terminal", "\x1b[H");
  });

  it("cancels pending mobile input when the terminal unmounts", async () => {
    const terminal = await render(kind);
    softKey(terminal, " ");
    await act(async () => root.render(null));
    await act(async () => vi.runAllTimers());
    expect(send).not.toHaveBeenCalled();
  });
});

it("enables remote input in place after replay and blocks it again on disconnect", async () => {
  const terminal = await render("remote", false, true);
  const buttons = () => allNodes(container).filter(node => node.tagName === "BUTTON");
  expect(buttons().every(node => props(node).disabled)).toBe(true);
  expect(terminal.options.disableStdin).toBe(true);
  terminal.input("blocked");
  softKey(terminal, " ");
  await render("remote");
  await act(async () => vi.runAllTimers());
  expect(send).not.toHaveBeenCalled();
  expect(mocks.terminals).toHaveLength(1);
  expect(terminal.options.disableStdin).toBe(false);
  expect(buttons().every(node => !props(node).disabled)).toBe(true);
  terminal.input("ready");
  expect(send).toHaveBeenCalledExactlyOnceWith("mobile-terminal", "ready");
  await render("remote", false, true);
  terminal.input("disconnected");
  softKey(terminal, "!");
  await act(async () => vi.runAllTimers());
  expect(send).toHaveBeenCalledTimes(1);
  expect(mocks.terminals).toHaveLength(1);
});

it("hides touch input controls and refuses input for a view-only remote", async () => {
  const terminal = await render("remote", true);
  expect(allNodes(container).some(node => props(node)?.role === "toolbar")).toBe(false);
  terminal.input("c");
  softKey(terminal, " ");
  await act(async () => vi.runAllTimers());
  expect(send).not.toHaveBeenCalled();
});
