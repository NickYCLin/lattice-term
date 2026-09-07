/** Normalize separators only. Invalid or legacy short secrets are rejected. */
export function normalizePairingToken(input: string): string | null {
  const token = input.replace(/[-\t\n\r\f\v ]/g, "").toUpperCase();
  return /^[0-9A-F]{32}$/.test(token) ? token : null;
}

/** Legacy viewer input is allowed by ID; the backend must verify an existing device pin. */
export function normalizeViewerPairingToken(input: string, viaRelay: boolean): string | null {
  const token = normalizePairingToken(input);
  if (token) return token;
  const code = input.replace(/[-\t\n\r\f\v ]/g, "");
  return viaRelay && /^[0-9]{8}$/.test(code) ? code : null;
}
