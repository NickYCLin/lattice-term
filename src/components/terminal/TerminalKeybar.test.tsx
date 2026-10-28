import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { allNodes, installHostDom, props, type HostNode } from "../agents/testFixtures/interactionDom";
import { TerminalKeybar, useTerminalControlKey } from "./TerminalKeybar";

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
  it.each([
    ["Enter", "\r"], ["Esc", "\x1b"], ["Tab", "\t"],
    ["\u2191", "\x1b[A"], ["\u2193", "\x1b[B"],
    ["\u2190", "\x1b[D"], ["\u2192", "\x1b[C"],
    ["Home", "\x1b[H"], ["End", "\x1b[F"],
    ["PgUp", "\x1b[5~"], ["PgDn", "\x1b[6~"], ["Del", "\x1b[3~"],
    ["|", "|"], ["-", "-"], ["~", "~"],
  ])("sends %s without altering the terminal sequence", async (label, sequence) => {
    const button = allNodes(container).find(node => node.tagName === "BUTTON" && node.textContent === label)!;
    await act(async () => props(button).onClick());
    expect(input).toHaveBeenCalledExactlyOnceWith(sequence);
  });

  it("toggles the software keyboard without stealing pointer focus", async () => {
    const toolbar = allNodes(container).find(node => props(node)?.role === "toolbar")!;
    const preventDefault = vi.fn();
    props(toolbar).onPointerDown({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    const button = allNodes(container).find(node => node.tagName === "BUTTON" && props(node)["aria-label"]);
    await act(async () => props(button!).onClick());
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
