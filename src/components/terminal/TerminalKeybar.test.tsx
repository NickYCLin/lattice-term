import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { allNodes, installHostDom, props, type HostNode } from "../agents/testFixtures/interactionDom";
import { preserveTerminalButtonFocus } from "./terminalPointerFocus";
import { openTerminalKeyboard, TerminalKeybar, useTerminalControlKey } from "./TerminalKeybar";

let container: HostNode;
let root: ReturnType<typeof createRoot>;
let controls: ReturnType<typeof useTerminalControlKey>;
const input = vi.fn();
const keyboard = vi.fn();

function Harness() {
  controls = useTerminalControlKey();
  return <I18nProvider locale="zh-TW"><TerminalKeybar
    ctrlArmed={controls.armed} onToggleCtrl={controls.toggle}
    onToggleKeyboard={keyboard} onInput={input}
  /></I18nProvider>;
}

beforeEach(async () => {
  container = installHostDom();
  root = createRoot(container as unknown as Element);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("touch terminal keys", () => {
  it("disables every helper key while retaining attachment actions", async () => {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><TerminalKeybar
      ctrlArmed={false} onToggleCtrl={vi.fn()} onToggleKeyboard={keyboard} onInput={input} disabled
    ><span>Attachment action</span></TerminalKeybar></I18nProvider>));
    const buttons = allNodes(container).filter(node => node.tagName === "BUTTON");
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every(node => props(node).disabled)).toBe(true);
    expect(container.textContent).toContain("Attachment action");
  });

  it.each([
    ["空白", " "], ["Enter", "\r"], ["Esc", "\x1b"], ["Tab", "\t"],
    ["\u2191", "\x1b[A"], ["\u2193", "\x1b[B"],
    ["\u2190", "\x1b[D"], ["\u2192", "\x1b[C"],
    ["Home", "\x1b[H"], ["End", "\x1b[F"],
    ["PgUp", "\x1b[5~"], ["PgDn", "\x1b[6~"], ["Del", "\x1b[3~"],
    ["|", "|"], ["-", "-"], ["~", "~"],
  ])("sends %s without altering the terminal sequence", async (label, sequence) => {
    const button = allNodes(container).find(node => node.tagName === "BUTTON" && node.textContent === label)!;
    const toolbar = allNodes(container).find(node => props(node)?.role === "toolbar")!;
    const terminal = {} as Element;
    Object.assign(document, { activeElement: terminal });
    const preventDefault = vi.fn();
    props(toolbar).onPointerDown({ target: { closest: () => button }, preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    await act(async () => props(button).onClick());
    expect(input).toHaveBeenCalledExactlyOnceWith(sequence);
    expect(document.activeElement).toBe(terminal);
  });

  it("keeps the keyboard button pointer gesture uncancelled and invokes its callback synchronously", async () => {
    const toolbar = allNodes(container).find(node => props(node)?.role === "toolbar")!;
    const preventDefault = vi.fn();
    const button = allNodes(container).find(node => node.tagName === "BUTTON" && props(node)["aria-label"] === "開啟鍵盤")!;
    // closest returns the button even when the pointer starts on its SVG.
    props(toolbar).onPointerDown({ target: { closest: () => button }, preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    props(button).onClick();
    expect(keyboard).toHaveBeenCalledOnce();
  });

  it("consumes Ctrl only once even before React renders again", async () => {
    let first = "";
    let second = "";
    await act(async () => {
      controls.toggle();
      first = controls.consume("c");
      second = controls.consume("c");
    });
    expect(first).toBe("\x03");
    expect(second).toBe("c");
    expect(controls.armed).toBe(false);
  });

  it("keeps Ctrl armed across arrow sequences and allows cancellation", async () => {
    await act(async () => controls.toggle());
    expect(controls.armed).toBe(true);
    expect(controls.consume("\x1b[A")).toBe("\x1b[A");
    await act(async () => controls.toggle());
    expect(controls.armed).toBe(false);
    expect(controls.consume("d")).toBe("d");
  });
});


it.each([false, true])("opens the keyboard synchronously without an initial blur: alreadyFocused=%s", focused => {
  const calls: string[] = [];
  const textarea = { ownerDocument: document } as HTMLTextAreaElement;
  Object.assign(document, { activeElement: focused ? textarea : null });
  openTerminalKeyboard({ textarea, blur: () => calls.push("blur"), focus: () => calls.push("focus") });
  expect(calls).toEqual(focused ? ["blur", "focus"] : ["focus"]);
  expect(() => openTerminalKeyboard(null)).not.toThrow();
});

it("focuses safely if xterm has not attached its textarea yet", () => {
  const blur = vi.fn(), focus = vi.fn();
  openTerminalKeyboard({ textarea: undefined, blur, focus });
  expect(blur).not.toHaveBeenCalled(); expect(focus).toHaveBeenCalledOnce();
});


it.each([["c", "\x03"], ["d", "\x04"], ["z", "\x1a"]])("arms Ctrl through its button before typing %s", async (letter, expected) => {
  const ctrl = allNodes(container).find(node => props(node)?.["aria-pressed"] === false)!;
  const preventDefault = vi.fn();
  const toolbar = allNodes(container).find(node => props(node)?.role === "toolbar")!;
  props(toolbar).onPointerDown({ target: { closest: () => ctrl }, preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  await act(async () => props(ctrl).onClick());
  expect(props(ctrl)["aria-pressed"]).toBe(true);
  let actual = "";
  await act(async () => { actual = controls.consume(letter); });
  expect(actual).toBe(expected); expect(controls.armed).toBe(false);
});
it("protects nested button glyphs without preventing inputs from receiving focus", () => {
  const preventDefault = vi.fn();
  preserveTerminalButtonFocus({ target: { closest: () => null } as unknown as EventTarget, preventDefault });
  expect(preventDefault).not.toHaveBeenCalled();
  preserveTerminalButtonFocus({ target: { closest: () => ({ tagName: "BUTTON" }) } as unknown as EventTarget, preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
});
