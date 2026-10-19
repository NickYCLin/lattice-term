import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTypography, attachTerminalTypography, normalizeInterfaceScale, normalizeOutputFontSize } from "./typography";

afterEach(() => vi.unstubAllGlobals());

describe("text size preferences", () => {
  it.each([undefined, null, "150", NaN, Infinity, -Infinity])("ignores invalid sizes: %s", value => {
    expect(normalizeInterfaceScale(value)).toBe(100);
    expect(normalizeOutputFontSize(value)).toBe(13);
  });

  it("bounds and rounds numeric sizes", () => {
    expect(normalizeInterfaceScale(50)).toBe(100);
    expect(normalizeInterfaceScale(250)).toBe(200);
    expect(normalizeInterfaceScale(149.8)).toBe(150);
    expect(normalizeOutputFontSize(5)).toBe(12);
    expect(normalizeOutputFontSize(50)).toBe(32);
    expect(normalizeOutputFontSize(20.2)).toBe(20);
  });

  it("resizes every attached terminal in place, only refits on change and unsubscribes", () => {
    const events = new EventTarget();
    const dataset: Record<string, string> = {};
    const setProperty = vi.fn();
    vi.stubGlobal("window", events);
    vi.stubGlobal("document", { documentElement: { dataset, style: { setProperty } } });
    const terminal = { options: { fontSize: 13 }, reset: vi.fn(), clear: vi.fn(), dispose: vi.fn() };
    const remoteTerminal = { options: { fontSize: 13 } };
    const fit = vi.fn();
    const remoteFit = vi.fn();
    const stop = attachTerminalTypography(terminal, fit);
    const stopRemote = attachTerminalTypography(remoteTerminal, remoteFit);
    expect(fit).not.toHaveBeenCalled();
    applyTypography(150, 24);
    expect(setProperty).toHaveBeenCalledWith("--interface-text-scale", "1.5");
    expect(setProperty).toHaveBeenCalledWith("--output-font-size", "24px");
    expect(terminal.options.fontSize).toBe(24);
    expect(remoteTerminal.options.fontSize).toBe(24);
    expect(fit).toHaveBeenCalledTimes(1);
    expect(remoteFit).toHaveBeenCalledTimes(1);
    applyTypography(200, 24);
    expect(fit).toHaveBeenCalledTimes(1);
    stop();
    applyTypography(100, 13);
    expect(terminal.options.fontSize).toBe(24);
    expect(remoteTerminal.options.fontSize).toBe(13);
    expect(terminal.reset).not.toHaveBeenCalled();
    expect(terminal.clear).not.toHaveBeenCalled();
    expect(terminal.dispose).not.toHaveBeenCalled();
    stopRemote();
    const reopened = { options: { fontSize: 13 } };
    applyTypography(150, 20);
    const stopReopened = attachTerminalTypography(reopened, fit);
    expect(reopened.options.fontSize).toBe(20);
    stopReopened();
  });
});
