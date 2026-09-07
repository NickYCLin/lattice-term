import { describe, expect, it } from "vitest";
import { observeMobileViewport } from "./useMobileViewport";

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
    ownerDocument: { activeElement: { matches: () => editing } },
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
