import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { useFileDrop } from "../../app/fileDrop";
import { inspectLocalPath } from "../../app/localFiles";
import { installHostDom } from "../agents/testFixtures/interactionDom";
import { FileDropZone } from "./FileDropZone";
import { PathDropZone } from "./PathDropZone";

vi.mock("../../app/fileDrop", async importOriginal => ({ ...await importOriginal<typeof import("../../app/fileDrop")>(), useFileDrop: vi.fn(() => ({ dragging: false })) }));
vi.mock("../../app/localFiles", async importOriginal => ({ ...await importOriginal<typeof import("../../app/localFiles")>(), inspectLocalPath: vi.fn(), droppedUpload: async (path: string) => {
  const info = await inspectLocalPath(path);
  return { name: info.name, size: info.size, nativePath: path };
} }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

it.each(["file", "path"] as const)("keeps a valid %s drop working", async kind => {
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  const onSelect = vi.fn();
  vi.mocked(inspectLocalPath).mockResolvedValue({ kind: "file", name: "sample.txt", size: 1 });
  try {
    await act(async () => root.render(<I18nProvider locale="en">{kind === "file"
      ? <FileDropZone onSelect={onSelect}>Choose file</FileDropZone>
      : <PathDropZone kind="file" onSelect={onSelect}>Choose path</PathDropZone>}</I18nProvider>));
    await act(async () => { await vi.mocked(useFileDrop).mock.lastCall![0].onPaths(["/local/sample.txt"]); });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(kind === "file" ? { name: "sample.txt", size: 1, nativePath: "/local/sample.txt" } : "/local/sample.txt");
  } finally { await act(async () => root.unmount()); }
});

it.each([
  ["file", "unmount"], ["path", "unmount"],
  ["file", "disable"], ["path", "disable"],
] as const)("ignores late %s metadata after %s", async (kind, change) => {
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  const onSelect = vi.fn();
  let finish!: (info: { kind: "file"; name: string; size: number }) => void;
  vi.mocked(inspectLocalPath).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const render = async (disabled: boolean) => { await act(async () => root.render(<I18nProvider locale="en">{kind === "file"
    ? <FileDropZone disabled={disabled} onSelect={onSelect}>Choose file</FileDropZone>
    : <PathDropZone kind="file" disabled={disabled} onSelect={onSelect}>Choose path</PathDropZone>}</I18nProvider>)); };
  let unmounted = false;
  let dropping: void | Promise<void>;
  try {
    await render(false);
    await act(async () => { dropping = vi.mocked(useFileDrop).mock.lastCall![0].onPaths(["/local/sample.txt"]); });
    if (change === "unmount") {
      await act(async () => root.unmount());
      unmounted = true;
    } else {
      await render(true);
      await render(false);
    }
    await act(async () => { finish({ kind: "file", name: "sample.txt", size: 1 }); await dropping; });
    expect(onSelect).not.toHaveBeenCalled();
  } finally { if (!unmounted) await act(async () => root.unmount()); }
});
