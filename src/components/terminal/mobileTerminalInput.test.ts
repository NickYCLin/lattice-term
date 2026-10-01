import { describe, expect, it } from "vitest";
import { MobileTerminalInput } from "./mobileTerminalInput";

function harness(enabled = true) {
  const textarea = new EventTarget() as HTMLTextAreaElement;
  const sent: string[] = [];
  const tasks: Array<() => void> = [];
  const input = new MobileTerminalInput(
    textarea,
    (data) => sent.push(data),
    enabled,
    (task) => {
      tasks.push(task);
      return tasks.length as unknown as ReturnType<typeof setTimeout>;
    },
    () => {},
  );
  const flush = () => {
    while (tasks.length) tasks.shift()?.();
  };
  return { textarea, input, sent, flush };
}

function keydown(key: string, keyCode: number, isComposing = false) {
  return Object.assign(new Event("keydown", { cancelable: true }), {
    key,
    keyCode,
    isComposing,
  }) as KeyboardEvent;
}

function beforeinput(inputType: string, data: string | null, isComposing = false) {
  return Object.assign(new Event("beforeinput", { cancelable: true }), {
    inputType,
    data,
    isComposing,
  }) as InputEvent;
}

function type(
  textarea: EventTarget,
  input: MobileTerminalInput,
  data: string,
  inputType = "insertText",
) {
  const down = keydown("Unidentified", 229);
  const processed = input.shouldProcessTerminalKeyEvent(down);
  textarea.dispatchEvent(down);
  const event = beforeinput(inputType, data);
  textarea.dispatchEvent(event);
  return { processed, event };
}

describe("MobileTerminalInput", () => {
  it("sends a soft-keyboard space and punctuation exactly once", () => {
    const { textarea, input, sent, flush } = harness();

    const space = type(textarea, input, " ");
    const comma = type(textarea, input, "，");
    const bang = type(textarea, input, "!");
    flush();

    expect(sent).toEqual([" ，!"]);
    expect(space.event.defaultPrevented).toBe(true);
    expect(comma.event.defaultPrevented).toBe(true);
    expect(bang.event.defaultPrevented).toBe(true);
    expect(space.processed).toBe(false);
  });

  it("sends a soft-keyboard backspace as DEL", () => {
    const { textarea, input, sent, flush } = harness();

    const { event } = type(textarea, input, "", "deleteContentBackward");
    flush();

    expect(sent).toEqual(["\x7f"]);
    expect(event.defaultPrevented).toBe(true);
  });

  it("delivers after the zero-delay turn that commits a composition", () => {
    const { textarea, input, sent, flush } = harness();

    type(textarea, input, " ");

    expect(sent).toEqual([]);
    flush();
    expect(sent).toEqual([" "]);
  });

  it("leaves composition input and its candidate keys to xterm", () => {
    const { textarea, input, sent, flush } = harness();

    textarea.dispatchEvent(new Event("compositionstart"));
    const down = keydown("Unidentified", 229);
    const processed = input.shouldProcessTerminalKeyEvent(down);
    textarea.dispatchEvent(down);
    const event = beforeinput("insertText", " ");
    textarea.dispatchEvent(event);
    const composing = beforeinput("insertCompositionText", "ni", true);
    textarea.dispatchEvent(composing);
    flush();

    expect(processed).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(composing.defaultPrevented).toBe(false);
    expect(sent).toEqual([]);

    textarea.dispatchEvent(new Event("compositionend"));
    type(textarea, input, " ");
    flush();
    expect(sent).toEqual([" "]);
  });

  it("does not resend a character xterm already sent from keypress", () => {
    const { textarea, input, sent, flush } = harness();

    const down = keydown(" ", 32);
    expect(input.shouldProcessTerminalKeyEvent(down)).toBe(true);
    textarea.dispatchEvent(down);
    const press = Object.assign(new Event("keypress", { cancelable: true }), {
      key: " ",
    });
    press.preventDefault();
    textarea.dispatchEvent(press);
    const event = beforeinput("insertText", " ");
    textarea.dispatchEvent(event);
    flush();

    expect(sent).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  it("leaves a real Backspace key to xterm", () => {
    const { textarea, input, sent, flush } = harness();

    const down = keydown("Backspace", 8);
    expect(input.shouldProcessTerminalKeyEvent(down)).toBe(true);
    textarea.dispatchEvent(down);
    const event = beforeinput("deleteContentBackward", null);
    textarea.dispatchEvent(event);
    flush();

    expect(sent).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  it("stays out of the way on desktop keyboards", () => {
    const { textarea, input, sent, flush } = harness(false);

    const { processed, event } = type(textarea, input, " ");
    flush();

    expect(processed).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(sent).toEqual([]);
  });

  it("drops queued input when the view is disposed", () => {
    const { textarea, input, sent, flush } = harness();

    type(textarea, input, " ");
    input.dispose();
    flush();

    expect(sent).toEqual([]);
  });
});