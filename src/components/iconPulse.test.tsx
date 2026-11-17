import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installHostDom } from "./agents/testFixtures/interactionDom";
import {
  ICON_PULSE_MS,
  iconEnvironmentBlocksMotion,
  iconHoverEnabled,
  iconMotionEnabled,
  iconPrefersReducedMotion,
  iconRuntimeEnabled,
  isFalsyPulse,
  shouldPlayIconPulse,
  useIconAnimation,
  useIconPlayback,
  bindIconPressPulse,
  useIconPulse,
  useIconPulseWhen,
} from "./iconPulse";
import { SendIcon, CloseIcon, CheckIcon } from "./icons";
import { useRef, type ReactElement } from "react";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function stubMedia(options: {
  reduce?: boolean;
  hover?: boolean;
  stubSameList?: boolean;
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
}) {
  const reduce = {
    matches: options.reduce ?? false,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener() {},
    removeEventListener() {},
  };
  const hover = options.stubSameList
    ? reduce
    : {
        matches: options.hover ?? true,
        media: "(hover: hover)",
        addEventListener() {},
        removeEventListener() {},
      };
  const nav = {
    userAgent: options.userAgent ?? "Mozilla/5.0 Chrome/120.0.0.0",
    platform: options.platform ?? "MacIntel",
    maxTouchPoints: options.maxTouchPoints ?? 0,
  };
  vi.stubGlobal("navigator", nav);
  vi.stubGlobal("window", {
    matchMedia: (query: string) => (query.includes("prefers-reduced-motion") ? reduce : hover),
    navigator: nav,
  });
}

describe("icon pulse rules", () => {
  it("keeps pulses short and never treats empty values as a play", () => {
    expect(ICON_PULSE_MS).toBeLessThanOrEqual(600);
    expect(isFalsyPulse(0)).toBe(true);
    expect(isFalsyPulse(false)).toBe(true);
    expect(isFalsyPulse("")).toBe(true);
    expect(isFalsyPulse(undefined)).toBe(true);
    expect(isFalsyPulse("working")).toBe(false);
  });

  it("plays once on a change, not while the same status is held", () => {
    expect(shouldPlayIconPulse("working", "working", false)).toBe(false);
    expect(shouldPlayIconPulse("working", "idle", false)).toBe(true);
    expect(shouldPlayIconPulse(undefined, "working", false)).toBe(true);
    expect(shouldPlayIconPulse(undefined, 0, true)).toBe(false);
    expect(shouldPlayIconPulse("agents", "agents", true)).toBe(true);
  });

  it("stays completely still when prefers-reduced-motion is on", () => {
    stubMedia({ reduce: true, hover: true });
    expect(iconPrefersReducedMotion()).toBe(true);
    expect(iconRuntimeEnabled()).toBe(false);
    expect(iconHoverEnabled()).toBe(false);
    expect(iconMotionEnabled()).toBe(false);
  });

  it("treats a single stubbed MediaQueryList as reduced motion", () => {
    stubMedia({ reduce: false, hover: false, stubSameList: true, userAgent: "Mozilla/5.0 Chrome/120" });
    expect(iconPrefersReducedMotion()).toBe(true);
    expect(iconRuntimeEnabled()).toBe(false);
  });

  it("blocks the motion runtime in jsdom", () => {
    stubMedia({ reduce: false, hover: true, userAgent: "Mozilla/5.0 (linux) jsdom/27.0" });
    expect(iconEnvironmentBlocksMotion()).toBe(true);
    expect(iconRuntimeEnabled()).toBe(false);
  });

  it("enables the runtime on iOS / touch, but not hover autoplay", () => {
    stubMedia({
      reduce: false,
      hover: false,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      platform: "iPhone",
      maxTouchPoints: 5,
    });
    expect(iconPrefersReducedMotion()).toBe(false);
    expect(iconRuntimeEnabled()).toBe(true);
    expect(iconHoverEnabled()).toBe(false);
    expect(iconMotionEnabled()).toBe(false);
  });

  it("keeps desktop hover autoplay when a fine pointer can hover", () => {
    stubMedia({ reduce: false, hover: true, userAgent: "Mozilla/5.0 Chrome/120", platform: "MacIntel", maxTouchPoints: 0 });
    expect(iconRuntimeEnabled()).toBe(true);
    expect(iconHoverEnabled()).toBe(true);
    expect(iconMotionEnabled()).toBe(true);
  });
});

describe("useIconPulse hooks", () => {
  async function mount(node: ReturnType<typeof installHostDom>, element: ReactElement) {
    const root = createRoot(node as unknown as Element);
    await act(async () => {
      root.render(element);
    });
    return root;
  }

  it("increments after a signal change and skips the first paint", async () => {
    const host = installHostDom();
    function Probe({ signal }: { signal: string }) {
      const token = useIconPulse(signal);
      return <span>{String(token)}</span>;
    }
    const root = await mount(host, <Probe signal="working" />);
    expect(host.textContent).toBe("0");
    await act(async () => {
      root.render(<Probe signal="idle" />);
    });
    expect(host.textContent).toBe("1");
    await act(async () => {
      root.render(<Probe signal="idle" />);
    });
    expect(host.textContent).toBe("1");
    await act(async () => root.unmount());
  });

  it("pulses only when a tab becomes selected", async () => {
    const host = installHostDom();
    function Probe({ active }: { active: boolean }) {
      const token = useIconPulseWhen(active);
      return <span>{String(token)}</span>;
    }
    const root = await mount(host, <Probe active={false} />);
    expect(host.textContent).toBe("0");
    await act(async () => {
      root.render(<Probe active={true} />);
    });
    expect(host.textContent).toBe("1");
    await act(async () => {
      root.render(<Probe active={true} />);
    });
    expect(host.textContent).toBe("1");
    await act(async () => {
      root.render(<Probe active={false} />);
    });
    expect(host.textContent).toBe("1");
    await act(async () => root.unmount());
  });

  it("plays a pulse token on mount when asked, then on later changes", async () => {
    const host = installHostDom();
    function Probe({ pulse }: { pulse: string }) {
      const token = useIconPlayback(pulse, { enabled: true, pulseOnMount: true });
      return <span>{String(token)}</span>;
    }
    const root = await mount(host, <Probe pulse="agents" />);
    expect(host.textContent).toBe("1");
    await act(async () => {
      root.render(<Probe pulse="settings" />);
    });
    expect(host.textContent).toBe("2");
    await act(async () => root.unmount());
  });

  it("does not play when the runtime is disabled (reduced motion / tests)", async () => {
    const host = installHostDom();
    function Probe({ pulse }: { pulse: string }) {
      const token = useIconPlayback(pulse, { enabled: false, pulseOnMount: true });
      return <span>{String(token)}</span>;
    }
    const root = await mount(host, <Probe pulse="agents" />);
    expect(host.textContent).toBe("0");
    await act(async () => {
      root.render(<Probe pulse="settings" />);
    });
    expect(host.textContent).toBe("0");
    await act(async () => root.unmount());
  });

  it("plays startAnimation once on trigger and stops within 600ms", async () => {
    vi.useFakeTimers();
    const host = installHostDom();
    const handle = { startAnimation: vi.fn(), stopAnimation: vi.fn() };
    function Probe({ token }: { token: number }) {
      const handleRef = useRef(handle);
      useIconAnimation(handleRef, token, true);
      return <span>{String(token)}</span>;
    }
    const root = await mount(host, <Probe token={0} />);
    expect(handle.startAnimation).not.toHaveBeenCalled();
    await act(async () => {
      root.render(<Probe token={1} />);
    });
    expect(handle.startAnimation).toHaveBeenCalledTimes(1);
    expect(handle.stopAnimation).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(ICON_PULSE_MS);
    });
    expect(handle.stopAnimation).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it("binds a press trigger on the closest button and unbinds on cleanup", () => {
    const pulses: number[] = [];
    const listeners = new Map<string, Array<() => void>>();
    const button = {
      addEventListener(name: string, fn: () => void) {
        listeners.set(name, [...(listeners.get(name) ?? []), fn]);
      },
      removeEventListener(name: string, fn: () => void) {
        listeners.set(name, (listeners.get(name) ?? []).filter((item) => item !== fn));
      },
    };
    const root = {
      closest: () => button,
      parentElement: button,
    };
    const stop = bindIconPressPulse(root as unknown as Element, () => pulses.push(pulses.length + 1));
    expect(listeners.get("pointerdown")).toHaveLength(1);
    listeners.get("pointerdown")![0]();
    listeners.get("pointerdown")![0]();
    expect(pulses).toEqual([1, 2]);
    stop();
    expect(listeners.get("pointerdown")).toEqual([]);
  });
});

describe("icon markup", () => {
  it("does not forward pulse props onto the static SVG in tests", () => {
    const html = renderToStaticMarkup(
      <>
        <SendIcon size={16} pulse="send" pulseOnMount />
        <CloseIcon size={16} pulse={1} />
        <CheckIcon size={16} pulse={0} />
      </>,
    );
    expect(html).toContain("<svg");
    expect(html).not.toContain("pulse=");
    expect(html).not.toContain("pulseOnMount");
  });
});
