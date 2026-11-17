import { afterEach, describe, expect, it, vi } from "vitest";
import { observeMobileViewport, useMobileViewport } from "./useMobileViewport";

const host = vi.hoisted(() => ({
  effects: [] as (() => void | (() => void))[],
  invoke: vi.fn(async () => undefined),
}));
vi.mock("react", () => ({ useEffect: (effect: () => void | (() => void)) => host.effects.push(effect) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: host.invoke, isTauri: () => true }));

afterEach(() => {
  host.effects = [];
  host.invoke.mockClear();
  vi.unstubAllGlobals();
});

function fixture(withViewport = true) {
  const styles = new Map<string, string>();
  const attributes = new Map<string, string>();
  let editing = true;
  const viewport = Object.assign(new EventTarget(), { height: 852, width: 390, offsetTop: 0, offsetLeft: 0, scale: 1 });
  let nextId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const win = Object.assign(new EventTarget(), {
    innerHeight: 852,
    innerWidth: 390,
    screen: { width: 390, height: 852 },
    visualViewport: withViewport ? viewport : null,
    requestAnimationFrame(callback: FrameRequestCallback) { frames.set(++nextId, callback); return nextId; },
    cancelAnimationFrame(id: number) { frames.delete(id); },
  });
  const root = Object.assign(new EventTarget(), {
    style: {
      getPropertyValue: (name: string) => styles.get(name) ?? "",
      setProperty: (name: string, value: string) => styles.set(name, value),
      removeProperty: (name: string) => styles.delete(name),
    },
    ownerDocument: { activeElement: { matches: () => editing, closest: vi.fn((): HTMLElement | null => null), getBoundingClientRect: vi.fn(() => ({ top: 440, bottom: 482, left: 16, right: 374 })) } },
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
  });
  return {
    win, viewport, root, styles, attributes, frames,
    setEditing: (value: boolean) => { editing = value; },
    flush: () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(0)); },
    start: () => observeMobileViewport(win as unknown as Window, root as unknown as HTMLElement),
  };
}

describe("mobile keyboard viewport", () => {
  it("scrolls only a clipped focused drawer field after the keyboard shrinks the body", () => {
    const mobile = fixture();
    const body = { scrollTop: 0, getBoundingClientRect: () => ({ top: 120, bottom: 470 }) };
    const field = mobile.root.ownerDocument.activeElement;
    field.closest.mockReturnValue(body as unknown as HTMLElement);
    const stop = mobile.start();
    expect(body.scrollTop).toBe(0);
    mobile.viewport.height = 540;
    mobile.viewport.dispatchEvent(new Event("resize"));
    mobile.flush();
    expect(body.scrollTop).toBe(20);
    field.getBoundingClientRect.mockReturnValue({ top: 200, bottom: 242, left: 16, right: 374 });
    mobile.viewport.dispatchEvent(new Event("scroll"));
    mobile.flush();
    expect(body.scrollTop).toBe(20);
    field.getBoundingClientRect.mockReturnValue({ top: 110, bottom: 152, left: 16, right: 374 });
    mobile.root.dispatchEvent(new Event("focusin"));
    mobile.flush();
    expect(body.scrollTop).toBe(2);
    mobile.setEditing(false);
    mobile.viewport.dispatchEvent(new Event("resize"));
    mobile.flush();
    expect(body.scrollTop).toBe(2);
    stop();
  });

  it("notifies native layout after the mobile DOM observer is ready, without repeating on resize", async () => {
    const mobile = fixture();
    vi.stubGlobal("window", mobile.win);
    vi.stubGlobal("document", { documentElement: mobile.root });
    useMobileViewport(true);
    const stop = host.effects[0]();
    expect(mobile.styles.get("--app-viewport-height")).toBe("852px");
    await vi.waitFor(() => expect(host.invoke).toHaveBeenCalledExactlyOnceWith("mobile_frontend_ready"));
    mobile.viewport.dispatchEvent(new Event("resize"));
    mobile.flush();
    expect(host.invoke).toHaveBeenCalledTimes(1);
    if (typeof stop === "function") stop();
  });

  it("does not request native layout when disabled or already unmounted", async () => {
    useMobileViewport(false);
    expect(host.effects[0]()).toBeUndefined();
    const mobile = fixture();
    vi.stubGlobal("window", mobile.win);
    vi.stubGlobal("document", { documentElement: mobile.root });
    useMobileViewport(true);
    const stop = host.effects[1]();
    if (typeof stop === "function") stop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.invoke).not.toHaveBeenCalled();
  });

  it("keeps the app and overlays within the keyboard-visible height and offset", () => {
    const f = fixture();
    const stop = f.start();
    expect(f.styles.get("--app-viewport-height")).toBe("852px");
    f.viewport.height = 480;
    f.viewport.offsetTop = 24;
    f.viewport.dispatchEvent(new Event("resize"));
    f.viewport.dispatchEvent(new Event("scroll"));
    expect(f.frames.size).toBe(1);
    f.flush();
    expect(f.styles.get("--app-viewport-height")).toBe("480px");
    expect(f.styles.get("--app-viewport-top")).toBe("24px");
    expect(f.attributes.get("data-mobile-keyboard")).toBe("true");
    expect(f.attributes.get("data-mobile-keyboard-compact")).toBe("false");
    f.viewport.height = 852;
    f.viewport.offsetTop = 0;
    f.viewport.dispatchEvent(new Event("resize"));
    f.flush();
    expect(f.attributes.get("data-mobile-keyboard")).toBe("false");
    stop();
  });

  it("scrolls a focused dialog field without scrollIntoView so the overlay stays on screen", () => {
    const mobile = fixture();
    const dialog = {
      scrollTop: 0,
      getBoundingClientRect: () => ({ top: 40, bottom: 460, left: 8, right: 382 }),
    };
    const field = mobile.root.ownerDocument.activeElement as {
      closest: ReturnType<typeof vi.fn>;
      getBoundingClientRect: ReturnType<typeof vi.fn>;
      scrollIntoView?: ReturnType<typeof vi.fn>;
    };
    field.closest.mockImplementation((selector: string) => {
      if (selector.includes("drawer__body")) return null;
      if (selector.includes("dialog") || selector.includes("role='dialog'")) return dialog as unknown as HTMLElement;
      return null;
    });
    field.getBoundingClientRect.mockReturnValue({ top: 500, bottom: 542, left: 16, right: 374 });
    field.scrollIntoView = vi.fn();
    const stop = mobile.start();
    mobile.viewport.height = 520;
    mobile.viewport.dispatchEvent(new Event("resize"));
    mobile.flush();
    expect(dialog.scrollTop).toBe(90);
    expect(field.scrollIntoView).not.toHaveBeenCalled();
    const afterFirst = dialog.scrollTop;
    mobile.viewport.dispatchEvent(new Event("scroll"));
    mobile.flush();
    expect(dialog.scrollTop).toBe(afterFirst);
    stop();
  });

  it("still reveals a focused field when innerHeight shrinks with the visual viewport", () => {
    const mobile = fixture();
    const body = { scrollTop: 0, getBoundingClientRect: () => ({ top: 80, bottom: 360 }) };
    const field = mobile.root.ownerDocument.activeElement;
    field.closest.mockReturnValue(body as unknown as HTMLElement);
    field.getBoundingClientRect.mockReturnValue({ top: 400, bottom: 442, left: 16, right: 374 });
    const stop = mobile.start();
    mobile.win.innerHeight = mobile.viewport.height = 480;
    mobile.viewport.dispatchEvent(new Event("resize"));
    mobile.flush();
    expect(body.scrollTop).toBeGreaterThan(0);
    stop();
  });

  it("shrinks the layout for a landscape side keyboard without treating rotation itself as a keyboard", () => {
    const f = fixture();
    const stop = f.start();
    f.win.innerHeight = f.viewport.height = 393;
    f.win.innerWidth = f.viewport.width = 852;
    f.win.dispatchEvent(new Event("resize"));
    f.flush();
    expect(f.attributes.get("data-mobile-keyboard")).toBe("false");
    expect(f.styles.get("--app-viewport-width")).toBe("852px");
    f.viewport.width = 620;
    f.viewport.offsetLeft = 0;
    f.viewport.dispatchEvent(new Event("resize"));
    f.flush();
    expect(f.attributes.get("data-mobile-keyboard")).toBe("true");
    expect(f.attributes.get("data-mobile-keyboard-compact")).toBe("true");
    expect(f.styles.get("--app-viewport-width")).toBe("620px");
    expect(f.styles.get("--app-viewport-left")).toBe("0px");
    expect(f.styles.get("--app-viewport-height")).toBe("393px");
    stop();
  });

  it("does not mistake landscape rotation or non-editing browser chrome for a keyboard", () => {
    const f = fixture();
    const stop = f.start();
    f.win.innerHeight = f.viewport.height = 393;
    f.win.innerWidth = f.viewport.width = 852;
    f.win.dispatchEvent(new Event("resize"));
    f.flush();
    expect(f.attributes.get("data-mobile-keyboard")).toBe("false");
    f.setEditing(false);
    f.viewport.height = 250;
    f.viewport.dispatchEvent(new Event("resize"));
    f.flush();
    expect(f.attributes.get("data-mobile-keyboard")).toBe("false");
    stop();
  });

  it("preserves user pinch zoom without reflowing the layout", () => {
    const f = fixture();
    const stop = f.start();
    f.viewport.scale = 2;
    f.viewport.height = 426;
    f.viewport.dispatchEvent(new Event("resize"));
    f.flush();
    expect(f.styles.get("--app-viewport-height")).toBe("852px");
    expect(f.attributes.get("data-mobile-keyboard")).toBe("false");
    stop();
  });

  it("supports windows without VisualViewport and ignores transient zero measurements", () => {
    const f = fixture(false);
    const stop = f.start();
    f.win.innerHeight = 480;
    f.win.dispatchEvent(new Event("resize"));
    f.flush();
    expect(f.styles.get("--app-viewport-height")).toBe("480px");
    f.win.innerHeight = 0;
    f.win.dispatchEvent(new Event("resize"));
    f.flush();
    expect(f.styles.get("--app-viewport-height")).toBe("480px");
    stop();
  });

  it("cancels pending work, removes listeners and restores previous document styles", () => {
    const f = fixture();
    f.styles.set("--app-viewport-height", "90dvh");
    f.attributes.set("data-mobile-keyboard", "previous");
    f.attributes.set("data-mobile-keyboard-compact", "kept");
    const stop = f.start();
    f.viewport.dispatchEvent(new Event("resize"));
    stop();
    expect(f.frames.size).toBe(0);
    expect(f.styles.get("--app-viewport-height")).toBe("90dvh");
    expect(f.styles.has("--app-viewport-top")).toBe(false);
    expect(f.styles.has("--app-viewport-width")).toBe(false);
    expect(f.styles.has("--app-viewport-left")).toBe(false);
    expect(f.styles.has("--app-keyboard-inset")).toBe(false);
    expect(f.styles.has("--app-drawer-foot-height")).toBe(false);
    expect(f.attributes.get("data-mobile-keyboard")).toBe("previous");
    expect(f.attributes.get("data-mobile-keyboard-compact")).toBe("kept");
    f.viewport.dispatchEvent(new Event("resize"));
    f.root.dispatchEvent(new Event("focusin"));
    f.win.dispatchEvent(new Event("resize"));
    expect(f.frames.size).toBe(0);
  });

  it("scrolls the next drawer field above the footer when both fit in the visible band", () => {
    const mobile = fixture();
    const field = mobile.root.ownerDocument.activeElement as {
      matches: (s: string) => boolean;
      closest: ReturnType<typeof vi.fn>;
      getBoundingClientRect: ReturnType<typeof vi.fn>;
    };
    const next = {
      disabled: false,
      getAttribute: () => null,
      offsetParent: {},
      getClientRects: () => [{ width: 200, height: 50 }],
      getBoundingClientRect: () => ({ top: 412, bottom: 462, left: 16, right: 374 }),
      focus: vi.fn(),
    };
    const foot = { getBoundingClientRect: () => ({ top: 380, bottom: 460, height: 80 }) };
    const body = {
      scrollTop: 0,
      getBoundingClientRect: () => ({ top: 100, bottom: 380 }),
      querySelector: (selector: string) => (selector.includes("drawer__foot") ? foot : null),
      querySelectorAll: () => [field, next],
    };
    field.getBoundingClientRect.mockReturnValue({ top: 314, bottom: 364, left: 16, right: 374 });
    field.closest.mockImplementation(() => body);
    const stop = mobile.start();
    mobile.viewport.height = 540;
    mobile.viewport.dispatchEvent(new Event("resize"));
    mobile.flush();
    // next.bottom (462) - clipBottom (380) + 8
    expect(body.scrollTop).toBe(90);
    expect(mobile.styles.get("--app-keyboard-inset")).toBe("312px");
    expect(mobile.styles.get("--app-drawer-foot-height")).toBe("80px");
    stop();
  });

  it("moves focus to the next field when Enter is pressed on an enterKeyHint=next input", () => {
    const mobile = fixture();
    const field = mobile.root.ownerDocument.activeElement as unknown as {
      matches: (s: string) => boolean;
      closest: ReturnType<typeof vi.fn>;
      getBoundingClientRect: ReturnType<typeof vi.fn>;
      tagName: string;
      enterKeyHint: string;
      getAttribute: (name: string) => string | null;
    };
    const next = {
      disabled: false,
      getAttribute: () => null,
      offsetParent: {},
      getClientRects: () => [{ width: 200, height: 50 }],
      getBoundingClientRect: () => ({ top: 200, bottom: 250, left: 16, right: 374 }),
      focus: vi.fn(),
    };
    const body = {
      scrollTop: 0,
      getBoundingClientRect: () => ({ top: 80, bottom: 400 }),
      querySelector: () => null,
      querySelectorAll: () => [field, next],
    };
    field.tagName = "INPUT";
    field.enterKeyHint = "next";
    field.getAttribute = (name: string) => (name === "enterkeyhint" ? "next" : null);
    field.closest.mockImplementation(() => body);
    field.getBoundingClientRect.mockReturnValue({ top: 120, bottom: 170, left: 16, right: 374 });
    const handlers = new Map<string, EventListener>();
    const originalAdd = mobile.root.addEventListener.bind(mobile.root);
    mobile.root.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, options?: unknown) => {
      if (typeof fn === "function") handlers.set(type, fn);
      return originalAdd(type, fn, options as never);
    }) as typeof mobile.root.addEventListener;
    const stop = mobile.start();
    const event = {
      key: "Enter",
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      target: field,
    };
    handlers.get("keydown")?.(event as unknown as Event);
    expect(event.defaultPrevented).toBe(true);
    expect(next.focus).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does not treat a landscape footer as a clip edge once the keyboard is open", () => {
    const mobile = fixture();
    mobile.win.innerHeight = mobile.viewport.height = 390;
    mobile.win.innerWidth = mobile.viewport.width = 844;
    mobile.win.screen = { width: 390, height: 844 };
    const field = mobile.root.ownerDocument.activeElement as {
      closest: ReturnType<typeof vi.fn>;
      getBoundingClientRect: ReturnType<typeof vi.fn>;
    };
    const foot = { getBoundingClientRect: () => ({ top: 198, bottom: 226, height: 28 }) };
    const body = {
      scrollTop: 0,
      getBoundingClientRect: () => ({ top: 80, bottom: 420 }),
      querySelector: (selector: string) => (selector.includes("drawer__foot") ? foot : null),
      querySelectorAll: () => [field],
    };
    field.closest.mockImplementation(() => body);
    // Real iPhone 13 landscape failure: the next / focused field ends at 202,
    // overlapping a sticky footer at 198 but still above the keyboard at 226.
    field.getBoundingClientRect.mockReturnValue({ top: 152, bottom: 202, left: 28, right: 696 });
    const stop = mobile.start();
    mobile.viewport.height = 226;
    mobile.viewport.dispatchEvent(new Event("resize"));
    mobile.flush();
    expect(mobile.attributes.get("data-mobile-keyboard-compact")).toBe("true");
    // If the footer were still a clip edge, the field would be treated as
    // hidden (202 > 198) and the body would scroll. It is already above the
    // keyboard, so leave it where it is.
    expect(body.scrollTop).toBe(0);
    stop();
  });
});
