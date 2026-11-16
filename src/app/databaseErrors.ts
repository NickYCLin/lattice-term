import { jumpError } from "./jumpRoutes";
import type { I18nValue } from "../i18n/context";

const driverErrors = [
  "database.error.connection", "database.error.authentication",
  "database.error.databaseAccess", "database.error.tls", "database.error.other",
] as const;

/** Only our fixed driver codes are translated. Other validation/transaction
 * diagnostics retain their existing wording, including uncertain commits. */
export function databaseErrorMessage(reason: unknown, t: I18nValue["t"]): string {
  const raw = reason instanceof Error ? reason.message : String(reason);
  const code = raw.startsWith("Error: database.error.") ? raw.slice(7) : raw;
  const known = driverErrors.find(value => value === code);
  if (known) return t(known);
  // Do not echo malformed/future driver diagnostics with appended details.
  if (code.startsWith("database.error.")) return t("database.error.other");
  return /^(?:Error: )?(jump|target):/.test(raw) ? jumpError(raw.replace(/^Error: /, ""), t) : raw;
}
