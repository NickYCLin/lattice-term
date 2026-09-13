import { beforeEach, expect, it, vi } from "vitest";
import { droppedUpload, readSelectedText } from "./localFiles";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => invoke.mockReset());
it("rejects invalid UTF-8 browser files rather than silently replacing bytes", async () => {
  await expect(readSelectedText(new File([new Uint8Array([0xff])], "invalid.json"), 100)).rejects.toThrow("localFile.invalidText");
  expect(await readSelectedText(new File(["中文"], "valid.json"), 6)).toBe("中文");
});
it("keeps native uploads as paths and streams without loading their bytes", async () => {
  invoke.mockResolvedValue({ name: "large.bin", size: 5 * 1024 ** 3, kind: "file" });
  expect(await droppedUpload("/tmp/large.bin")).toEqual({ name: "large.bin", size: 5 * 1024 ** 3, nativePath: "/tmp/large.bin" });
  expect(invoke).toHaveBeenCalledExactlyOnceWith("local_path_info", { path: "/tmp/large.bin" });
});
it("rejects folders from a single-file picker", async () => {
  invoke.mockResolvedValue({ name: "folder", kind: "directory", size: 0 });
  await expect(droppedUpload("/tmp/folder")).rejects.toThrow("localFile.expectedFile");
});
it("rejects oversized imports before accessing their content", async () => {
  await expect(readSelectedText({ name: "backup", size: 200, nativePath: "/tmp/backup" }, 100)).rejects.toThrow("localFile.tooLarge");
  expect(invoke).not.toHaveBeenCalled();
});
it("passes a caller-specific bounded import limit to native reads", async () => {
  invoke.mockResolvedValue('{"name":"中文"}');
  expect(await readSelectedText({ name: "data.json", size: 17, nativePath: "/tmp/data.json" }, 1024)).toContain("中文");
  expect(invoke).toHaveBeenCalledExactlyOnceWith("local_file_read_text", { path: "/tmp/data.json", maxBytes: 1024 });
});
