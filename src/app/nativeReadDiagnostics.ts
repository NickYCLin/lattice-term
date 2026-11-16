import type { I18nValue } from "../i18n/context";
import { maskNativeText } from "./nativeRecords";
export interface NativeReadDiagnostics {
  skippedRows: number;
  reasons: Record<string, number>;
  partial: boolean;
}
const reasons = {
  empty: "history.reason.empty", decode: "history.reason.decode",
  size_limit: "history.reason.sizeLimit", changed: "history.reason.changed",
  unsupported_version: "history.reason.unsupported", no_readable_records: "history.reason.unreadable",
  permission: "history.reason.permission", unavailable: "history.reason.unavailable", read: "history.reason.read",
} as const;
export function nativeReadError(error: string, t: I18nValue["t"]): string {
  if (error.startsWith("native.read:")) {
    try {
      const value = JSON.parse(error.slice("native.read:".length));
      if (typeof value.cli === "string" && typeof value.file === "string") {
        const cli = maskNativeText(value.cli).slice(0, 40);
        const file = maskNativeText(value.file.replace(/\\/g, "/").split("/").pop() ?? "transcript").slice(0, 160);
        const key = reasons[value.reason as keyof typeof reasons] ?? reasons.read;
        return t("history.readDiagnostic", { cli, file, reason: t(key) });
      }
    } catch { /* Unknown errors still get masked below. */ }
  }
  return maskNativeText(error).replace(/(?:[A-Za-z]:[\\/]|\/)[^\s"<>]+/g, "[path]").slice(0, 1024);
}
