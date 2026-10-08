import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { desktopChatAccess } from "./desktopChat";
import { conversationDraftHasInput, removeConversationDraft, useConversationDraft } from "./useConversationDraft";

const image = { path: "C:/drafts/screenshot.png", name: "screenshot.png", isImage: true,
  preview: "C:/drafts/preview.png" };
const pick = { kind: "skill" as const, name: "PDF", path: "C:/skills/pdf", token: "$pdf" };
type DraftApi = ReturnType<typeof useConversationDraft>;

afterEach(() => {
  for (const kind of ["thread", "session"] as const) {
    for (const id of ["draft-test-a", "draft-test-b"]) removeConversationDraft(kind, id);
  }
});

it.each(["thread", "session"] as const)("restores %s text, attachments and mentions after switching and unmounting", async kind => {
  const container = installFakeDom();
  let root = createRoot(container as unknown as Element);
  let api!: DraftApi;
  function Probe({ id }: { id: string }) { api = useConversationDraft(kind, id); return null; }
  try {
    await act(async () => { root.render(<Probe id="draft-test-a" />); });
    await act(async () => { api.setDraft("檢查這張截圖 $pdf"); api.setAttachments([image]); api.setPicks([pick]); });
    await act(async () => { root.render(<Probe id="draft-test-b" />); });
    expect(api.draft).toBe("");
    expect(api.attachments).toEqual([]);
    await act(async () => { root.unmount(); });
    root = createRoot(container as unknown as Element);
    await act(async () => { root.render(<Probe id="draft-test-a" />); });
    expect(api.draft).toBe("檢查這張截圖 $pdf");
    expect(api.attachments).toEqual([image]);
    expect(api.picks).toEqual([pick]);
  } finally { await act(async () => { root.unmount(); }); }
});

it.each(["thread", "session"] as const)("keeps a late %s paste on its original conversation", async kind => {
  const container = installFakeDom();
  const root = createRoot(container as unknown as Element);
  let api!: DraftApi;
  function Probe({ id }: { id: string }) { api = useConversationDraft(kind, id); return null; }
  try {
    await act(async () => { root.render(<Probe id="draft-test-a" />); });
    const original = api;
    await act(async () => { original.setPasting(true); });
    await act(async () => { root.render(<Probe id="draft-test-b" />); });
    await act(async () => { api.addAttachmentPaths(["C:/drafts/other.png"]); });
    await act(async () => { original.addAttachmentPaths([image.path]); original.setPasting(false); });
    expect(api.attachments.map(file => file.path)).toEqual(["C:/drafts/other.png"]);
    await act(async () => { root.render(<Probe id="draft-test-a" />); });
    expect(api.attachments.map(file => file.path)).toEqual([image.path]);
    expect(api.pasting).toBe(false);
    await act(async () => { api.setAttachments([]); });
    await act(async () => { original.setAttachments(current => current.map(file => ({ ...file, preview: image.preview }))); });
    expect(api.attachments).toEqual([]);
  } finally { await act(async () => { root.unmount(); }); }
});

it("keeps hidden drafts blocking external sends and clears them only after input is cleared", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let api!: DraftApi;
  function Probe() { api = useConversationDraft("thread", "draft-test-a"); return null; }
  try {
    await act(async () => { root.render(<Probe />); });
    const original = api;
    await act(async () => { api.setAttachments([image]); });
    await act(async () => { root.render(null); });
    expect(desktopChatAccess.drafts.has("draft-test-a")).toBe(true);
    expect(conversationDraftHasInput("thread", "draft-test-a")).toBe(true);
    await act(async () => { original.setAttachments([]); original.setPasting(true); });
    expect(desktopChatAccess.drafts.has("draft-test-a")).toBe(true);
    await act(async () => { original.setPasting(false); original.setSteering(true); });
    expect(desktopChatAccess.drafts.has("draft-test-a")).toBe(true);
    await act(async () => { original.setSteering(false); });
    expect(desktopChatAccess.drafts.has("draft-test-a")).toBe(false);
  } finally { await act(async () => { root.unmount(); }); }
});

it("does not resurrect a deleted draft when a clipboard request completes late", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let api!: DraftApi;
  function Probe() { api = useConversationDraft("thread", "draft-test-a"); return null; }
  try {
    await act(async () => { root.render(<Probe />); });
    const original = api;
    await act(async () => { api.setPasting(true); root.render(null); });
    removeConversationDraft("thread", "draft-test-a");
    original.addAttachmentPaths([image.path]);
    original.setDraft("遲到的內容");
    await act(async () => { root.render(<Probe />); });
    expect(api.attachments).toEqual([]);
    expect(api.draft).toBe("");
    expect(api.pasting).toBe(false);
    expect(desktopChatAccess.drafts.has("draft-test-a")).toBe(false);
  } finally { await act(async () => { root.unmount(); }); }
});

it("separates session and thread drafts even when their IDs are identical", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let api!: DraftApi;
  function Probe({ kind }: { kind: "thread" | "session" }) { api = useConversationDraft(kind, "draft-test-a"); return null; }
  try {
    await act(async () => { root.render(<Probe kind="thread" />); });
    await act(async () => { api.setDraft("內建對話"); api.setAttachments([image]); });
    await act(async () => { root.render(<Probe kind="session" />); });
    expect(api.draft).toBe("");
    expect(api.attachments).toEqual([]);
    await act(async () => { root.render(<Probe kind="thread" />); });
    await act(async () => { api.setDraft(""); api.setAttachments([]); api.setPicks([]); });
    await act(async () => { root.render(null); });
    await act(async () => { root.render(<Probe kind="thread" />); });
    expect(api.draft).toBe("");
    expect(api.attachments).toEqual([]);
    expect(conversationDraftHasInput("thread", "draft-test-a")).toBe(false);
  } finally { await act(async () => { root.unmount(); }); }
});
