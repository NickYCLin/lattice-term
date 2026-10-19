export const DEFAULT_INTERFACE_SCALE = 100;
export const DEFAULT_OUTPUT_FONT_SIZE = 13;
const TYPOGRAPHY_EVENT = "latticeterm:typography";

export function normalizeInterfaceScale(value: unknown): number {
  return normalizeSize(value, 100, 200, DEFAULT_INTERFACE_SCALE);
}

export function normalizeOutputFontSize(value: unknown): number {
  return normalizeSize(value, 12, 32, DEFAULT_OUTPUT_FONT_SIZE);
}

function normalizeSize(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.round(value)))
    : fallback;
}

export function applyTypography(interfaceScale: number, outputFontSize: number): void {
  const root = document.documentElement;
  root.style.setProperty("--interface-text-scale", String(normalizeInterfaceScale(interfaceScale) / 100));
  root.style.setProperty("--output-font-size", `${normalizeOutputFontSize(outputFontSize)}px`);
  root.dataset.outputFontSize = String(normalizeOutputFontSize(outputFontSize));
  window.dispatchEvent(new Event(TYPOGRAPHY_EVENT));
}

export function attachTerminalTypography(
  terminal: { options: { fontSize?: number } },
  scheduleFit: () => void,
): () => void {
  const update = () => {
    const size = normalizeOutputFontSize(Number(document.documentElement.dataset.outputFontSize) || DEFAULT_OUTPUT_FONT_SIZE);
    if (terminal.options.fontSize === size) return;
    terminal.options.fontSize = size;
    scheduleFit();
  };
  update();
  window.addEventListener(TYPOGRAPHY_EVENT, update);
  return () => window.removeEventListener(TYPOGRAPHY_EVENT, update);
}
