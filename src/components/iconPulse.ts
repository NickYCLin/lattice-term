/**
 * Centralised PulsoIcon playback: one-shot pulses, never a loop.
 *
 * Hover/focus still uses Pulso autoAnimated on pointers that can hover.
 * Touch and status changes call startAnimation once, then stop within
 * ICON_PULSE_MS. prefers-reduced-motion, SSR, and jsdom stay completely still.
 */

import {
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

export const ICON_PULSE_MS = 600;

const PULSE_SENTINEL: unique symbol = Symbol("icon-pulse-mount");

const TRIGGER_SELECTOR =
  "button, a, label, summary, [role='button'], [role='menuitem'], [role='tab'], [role='link'], [data-icon-trigger]";

export function isFalsyPulse(value: unknown): boolean {
  return value === false || value === 0 || value === "" || value == null;
}

function userAgent(): string {
  if (typeof navigator !== "undefined" && navigator.userAgent) return navigator.userAgent;
  if (typeof window !== "undefined" && window.navigator?.userAgent) return window.navigator.userAgent;
  return "";
}

export function iconEnvironmentBlocksMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return true;
  }
  return /jsdom/i.test(userAgent());
}

function isRealMediaQueryList(value: MediaQueryList | { matches?: boolean; media?: string; addEventListener?: unknown } | null | undefined): boolean {
  return Boolean(
    value &&
      typeof value.media === "string" &&
      typeof value.addEventListener === "function",
  );
}

export function iconPrefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return true;
  }
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  const hover = window.matchMedia("(hover: hover)");
  // A stub that returns one MediaQueryList for every query is not a real browser.
  if (reduce === hover) return true;
  if (!isRealMediaQueryList(reduce) || !isRealMediaQueryList(hover)) return true;
  return reduce.matches;
}

/** Whether the motion runtime may mount (jsdom / SSR / reduced motion stay static). */
export function iconRuntimeEnabled(): boolean {
  if (iconEnvironmentBlocksMotion()) return false;
  if (iconPrefersReducedMotion()) return false;
  return true;
}

function isTouchPrimaryDevice(): boolean {
  const nav = typeof window !== "undefined" ? window.navigator : undefined;
  if (!nav) return false;
  return (
    /iP(hone|ad|od)/i.test(nav.userAgent) ||
    (nav.platform === "MacIntel" && nav.maxTouchPoints > 1)
  );
}

/** Desktop hover/focus autoplay. Touch uses event pulses instead. */
export function iconHoverEnabled(): boolean {
  if (!iconRuntimeEnabled()) return false;
  const hover = window.matchMedia("(hover: hover)");
  if (!hover.matches) return false;
  if (isTouchPrimaryDevice()) return false;
  return true;
}

/** @deprecated Prefer iconHoverEnabled; kept as the hover-autoplay gate. */
export function iconMotionEnabled(): boolean {
  return iconHoverEnabled();
}

export function shouldPlayIconPulse(
  previous: unknown,
  next: unknown,
  pulseOnMount = false,
): boolean {
  if (isFalsyPulse(next)) return false;
  if (Object.is(previous, next)) return pulseOnMount;
  if (previous === PULSE_SENTINEL) return pulseOnMount;
  return true;
}

/** Increment a token when `signal` changes after mount (skips the first paint). */
export function useIconPulse(signal?: unknown): number {
  const [token, setToken] = useState(0);
  const skipFirst = useRef(true);
  useEffect(() => {
    if (skipFirst.current) {
      skipFirst.current = false;
      return;
    }
    if (isFalsyPulse(signal)) return;
    setToken((count) => count + 1);
  }, [signal]);
  return token;
}

/** Increment a token only when `active` goes from false to true. */
export function useIconPulseWhen(active: boolean): number {
  const [token, setToken] = useState(0);
  const previous = useRef(active);
  useEffect(() => {
    if (active && !previous.current) setToken((count) => count + 1);
    previous.current = active;
  }, [active]);
  return token;
}

/** Attach a one-shot pulse to pointerdown on the closest interactive ancestor. */
export function bindIconPressPulse(root: Element, onPulse: () => void): () => void {
  const target =
    (typeof (root as HTMLElement).closest === "function"
      ? (root as HTMLElement).closest(TRIGGER_SELECTOR)
      : null) ?? root.parentElement;
  if (!target) return () => {};
  const onDown = () => onPulse();
  target.addEventListener("pointerdown", onDown);
  return () => target.removeEventListener("pointerdown", onDown);
}

/** Pointerdown on the closest interactive ancestor; used on touch, not hover. */
export function useIconPressPulse(
  wrapRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): number {
  const [token, setToken] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const root = wrapRef.current;
    if (!root) return;
    return bindIconPressPulse(root, () => setToken((count) => count + 1));
  }, [enabled, wrapRef]);
  return token;
}

export function useIconPlayback(
  pulse: unknown,
  options: { enabled: boolean; pulseOnMount?: boolean },
): number {
  const { enabled, pulseOnMount = false } = options;
  const [token, setToken] = useState(0);
  const previous = useRef<unknown>(pulseOnMount ? PULSE_SENTINEL : pulse);
  useEffect(() => {
    if (!enabled) {
      previous.current = pulseOnMount ? PULSE_SENTINEL : pulse;
      return;
    }
    const last = previous.current;
    if (Object.is(last, pulse)) return;
    previous.current = pulse;
    if (!shouldPlayIconPulse(last, pulse, last === PULSE_SENTINEL && pulseOnMount)) {
      return;
    }
    setToken((count) => count + 1);
  }, [pulse, enabled, pulseOnMount]);
  return token;
}

export function useIconAnimation(
  handleRef: RefObject<{ startAnimation?: () => void; stopAnimation?: () => void } | null>,
  token: number,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled || token === 0) return;
    const handle = handleRef.current;
    handle?.startAnimation?.();
    const timer = window.setTimeout(() => {
      handleRef.current?.stopAnimation?.();
    }, ICON_PULSE_MS);
    return () => {
      window.clearTimeout(timer);
      handleRef.current?.stopAnimation?.();
    };
  }, [token, enabled, handleRef]);
}
