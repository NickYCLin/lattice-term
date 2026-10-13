export type RdpCredentialFailure = "expired" | "mustChange" | "rejected";

export function rdpCredentialFailure(detail: string): RdpCredentialFailure | null {
  if (/\b(?:STATUS_PASSWORD_EXPIRED|0xC0000071)\b/i.test(detail)) return "expired";
  if (/\b(?:STATUS_PASSWORD_MUST_CHANGE|0xC0000224)\b/i.test(detail)) return "mustChange";
  if (/\b(?:STATUS_LOGON_FAILURE|STATUS_WRONG_PASSWORD|0xC000006D|0xC000006A)\b/i.test(detail)) return "rejected";
  return null;
}
