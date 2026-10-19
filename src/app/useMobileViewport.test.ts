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
  const viewport = Object.assign(new EventTarget(), { height: 852, offsetTop: 0, scale: 1 });
  let nextId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const win = Object.assign(new EventTarget(), {
    innerHeight: 852,
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
    ownerDocument: { activeElement: { matches: () => editing, closest: vi.fn((): HTMLElement | null => null), getBoundingClientRect: vi.fn(() => ({ top: 440, bottom: 482 })) } },
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
    field.getBoundingClientRect.mockReturnValue({ top: 200, bottom: 242 });
    mobile.viewport.dispatchEvent(new Event("scroll"));
    mobile.flush();
    expect(body.scrollTop).toBe(20);
    field.getBoundingClientRect.mockReturnValue({ top: 110, bottom: 152 });
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
    f.viewport.height = 852;
    f.viewport.offsetTop = 0;
    f.viewport.dispatchEvent(new Event("resize"));
    f.flush();
    expect(f.attributes.get("data-mobile-keyboard")).toBe("false");
    stop();
  });

  it("does not mistake landscape rotation or non-editing browser chrome for a keyboard", () => {
    const f = fixture();
    const stop = f.start();
    f.win.innerHeight = f.viewport.height = 393;
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
    const stop = f.start();
    f.viewport.dispatchEvent(new Event("resize"));
    stop();
    expect(f.frames.size).toBe(0);
    expect(f.styles.get("--app-viewport-height")).toBe("90dvh");
    expect(f.styles.has("--app-viewport-top")).toBe(false);
    expect(f.attributes.get("data-mobile-keyboard")).toBe("previous");
    f.viewport.dispatchEvent(new Event("resize"));
    f.root.dispatchEvent(new Event("focusin"));
    f.win.dispatchEvent(new Event("resize"));
    expect(f.frames.size).toBe(0);
  });
});
