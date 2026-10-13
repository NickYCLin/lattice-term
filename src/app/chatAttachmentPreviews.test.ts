import { expect, it, vi, afterEach } from "vitest";
import { keepChatAttachmentPreviews } from "./chatAttachmentPreviews";

const { invoke, available } = vi.hoisted(() => ({ invoke: vi.fn(), available: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./nativeRuntime", () => ({ hasDesktopBackend: available }));
afterEach(() => { invoke.mockReset(); available.mockReturnValue(true); });

it("waits for selected images to be copied without changing their original paths", async () => {
  let release!: (value: string) => void;
  invoke.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const image = { path: "C:/selected/photo.png", name: "photo.png", isImage: true };
  const document = { path: "C:/selected/readme.txt", name: "readme.txt", isImage: false };
  const saved = { ...image, path: "C:/other.png", preview: "C:/safe/other.png" };
  const pending = keepChatAttachmentPreviews("one", [image, document, saved]);
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  expect(invoke).toHaveBeenCalledWith("agent_chat_keep_image_preview", { threadId: "one", path: image.path });
  release("C:/safe/photo.png");
  expect(await pending).toEqual([{ ...image, preview: "C:/safe/photo.png" }, document, saved]);
  expect(image).not.toHaveProperty("preview");
});

it("does not copy files in a browser or invent previews when the backend declines", async () => {
  const image = { path: "photo.png", name: "photo.png", isImage: true };
  available.mockReturnValue(false);
  expect(await keepChatAttachmentPreviews("one", [image])).toEqual([image]);
  expect(invoke).not.toHaveBeenCalled();
  available.mockReturnValue(true);
  invoke.mockResolvedValue(null);
  expect(await keepChatAttachmentPreviews("one", [image])).toEqual([image]);
});

it("reports copy failures rather than sending before a pending copy settles", async () => {
  invoke.mockRejectedValue(new Error("copy failed"));
  await expect(keepChatAttachmentPreviews("one", [{ path: "photo.png", name: "photo.png", isImage: true }])).rejects.toThrow("copy failed");
});
