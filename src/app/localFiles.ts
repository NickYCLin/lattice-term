import { invoke } from "@tauri-apps/api/core";
import type { MessageKey } from "../i18n/messages/zh-TW";

export interface NativeFile { name: string; size: number; nativePath: string }
export type UploadFile = File | NativeFile;
export async function inspectLocalPath(path: string): Promise<{ name: string; size: number; kind: "file" | "directory" }> {
  return invoke("local_path_info", { path });
}
export async function droppedUpload(path: string): Promise<NativeFile> {
  const info = await inspectLocalPath(path);
  if (info.kind !== "file") throw new Error("localFile.expectedFile");
  return { name: info.name, size: info.size, nativePath: path };
}
export async function droppedText(path: string, maxBytes: number): Promise<string> {
  return invoke("local_file_read_text", { path, maxBytes });
}
const errorKeys = new Set<string>(["localFile.invalidPath", "localFile.unreadable", "localFile.unsupported", "localFile.tooLarge", "localFile.invalidText", "localFile.changed", "localFile.expectedFile", "localFile.expectedDirectory", "localFile.single"]);
export function localFileError(reason: unknown, t: (key: MessageKey) => string): string {
  const detail = reason instanceof Error ? reason.message : String(reason);
  return errorKeys.has(detail) ? t(detail as MessageKey) : detail;
}

export async function readSelectedText(file: UploadFile, maxBytes: number): Promise<string> {
  if (file.size > maxBytes) throw new Error("localFile.tooLarge");
  if ("nativePath" in file) return droppedText(file.nativePath, maxBytes);
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > maxBytes) throw new Error("localFile.tooLarge");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("localFile.invalidText"); }
}
