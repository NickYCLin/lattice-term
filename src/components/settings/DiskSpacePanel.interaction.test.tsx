import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { allNodes, installHostDom, onClick } from "../agents/testFixtures/interactionDom";
import { DiskSpacePanel } from "./DiskSpacePanel";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

it("scans on demand and sends only the selected maintenance action", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as HTMLElement);
  const image = { path: "chat/image.png", bytes: 128, compressed: false, stored: null };
  const log = { ...image, path: "claude/id/projects/demo/session.jsonl" };
  invoke.mockImplementation(async (command, args) => {
    if (command === "disk_usage") return { profiles: 128, chats: 128, webview: 0, partial: false, attachments: [image], history: [log] };
    if (command === "disk_compress_history") log.compressed = args.compress;
  });
  async function click(label: string) {
    const button = allNodes(container).find(node => node.tagName === "BUTTON" && node.textContent === label);
    expect(button).toBeDefined();
    await act(async () => { onClick(button!)(); });
  }
  try {
    await act(async () => root.render(<I18nProvider locale="en"><DiskSpacePanel /></I18nProvider>));
    expect(invoke).not.toHaveBeenCalled();
    await click("Check usage");
    await click("Show in Explorer");
    expect(invoke).toHaveBeenLastCalledWith("disk_reveal_attachment", { path: image.path });
    await click("Compress transcript");
    expect(invoke).toHaveBeenCalledWith("disk_compress_history", { path: log.path, compress: true });
    await click("Decompress");
    expect(invoke).toHaveBeenCalledWith("disk_compress_history", { path: log.path, compress: false });
    await click("Clear WebView2 disk cache");
    expect(container.textContent).toContain("WebView2 disk cache cleared.");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
