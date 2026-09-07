/** Normalize separators only. Invalid or legacy short secrets are rejected. */
export function normalizePairingToken(input: string): string | null {
  const token = input.replace(/[-\t\n\r\f\v ]/g, "").toUpperCase();
  return /^[0-9A-F]{32}$/.test(token) ? token : null;
}

/** Only uppercase grouped tokens are display aliases; raw passwords keep case. */
export function normalizePairingPassword(input: string): string | null {
  if (/^[0-9A-F]{4}(?:-[0-9A-F]{4}){7}$/.test(input)) return input.replace(/-/g, "");
  return /^[\x21-\x7e]{6,64}$/.test(input) ? input : null;
}

/** Legacy pairing is explicit and still needs a device pin in the backend. */
export function normalizeViewerPairingToken(input: string, viaRelay: boolean, legacy = false): string | null {
  if (!legacy) return normalizePairingPassword(input);
  const token = normalizePairingToken(input);
  if (token) return token;
  if (!viaRelay) return null;
  const code = input.replace(/[-\t\n\r\f\v ]/g, "");
  return /^[0-9]{8}$/.test(code) ? code : null;
}
