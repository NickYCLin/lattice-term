const formatters = new Map<string, Intl.NumberFormat>();
/** Reuse Intl formatters across transfer progress updates. */
export function formatDecimal(value: number, digits: number, locale?: string): string {
  if (!locale) return value.toFixed(digits);
  const key = `${locale}:${digits}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false });
    if (formatters.size >= 32) formatters.clear();
    formatters.set(key, formatter);
  }
  return formatter.format(value);
}
