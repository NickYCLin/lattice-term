/** The CLI's empty model ID means its default, whatever its English label says. */
export function modelDisplayLabel(value: string, label: string | null | undefined, defaultLabel: string): string {
  return value ? label || value : defaultLabel;
}
