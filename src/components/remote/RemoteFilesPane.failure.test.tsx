import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { useFileDrop } from "../../app/fileDrop";
import type { RemoteApi, RemoteDirectory, RemoteSessionSummary } from "../../app/useRemoteSessions";
import { allNodes, installHostDom, props } from "../agents/testFixtures/interactionDom";
import { RemoteFilesPane } from "./RemoteFilesPane";

vi.mock("../../app/fileDrop", () => ({ useFileDrop: vi.fn(() => ({ dragging: false })) }));
vi.mock("../files/RemoteTextEditorProvider", () => ({ useRemoteTextEditor: () => ({ active: false, open: vi.fn() }) }));
vi.mock("../overlays/useAppDialogs", () => ({ useAppDialogs: () => ({ confirm: vi.fn(), dialogs: null }) }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("disables uploads after navigation fails and allows retry and parent recovery", async () => {
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  const listFiles = vi.fn().mockResolvedValueOnce({ path: "/known", entries: [] })
    .mockRejectedValueOnce(new Error("listing unavailable"))
    .mockRejectedValueOnce(new Error("retry unavailable"))
    .mockResolvedValueOnce({ path: "/unknown", entries: [] });
  const remote = { listFiles, transfers: {} } as unknown as RemoteApi;
  const button = (text: string) => allNodes(host).find(node => node.tagName === "BUTTON" && node.textContent === text)!;
  const refresh = () => allNodes(host).find(node => node.tagName === "BUTTON" && props(node)["aria-label"] === "Refresh")!;
  try {
    await act(async () => root.render(<I18nProvider locale="en"><RemoteFilesPane session={{ sessionId: "remote-1", fileRootLabel: "Shared" } as RemoteSessionSummary} remote={remote} /></I18nProvider>));
    const input = allNodes(host).find(node => node.tagName === "INPUT" && props(node).type !== "file")!;
    await act(async () => props(input).onChange({ currentTarget: { value: "/unknown/target" } }));
    await act(async () => props(allNodes(host).find(node => node.tagName === "FORM")!).onSubmit({ preventDefault() {} }));
    expect(host.textContent).toContain("listing unavailable");
    expect(props(button("Upload")).disabled).toBe(true);
    expect(vi.mocked(useFileDrop).mock.lastCall![0].disabled).toBe(true);
    expect(props(refresh()).disabled).toBe(false);
    await act(async () => props(refresh()).onClick());
    expect(listFiles).toHaveBeenLastCalledWith("remote-1", "/unknown/target");
    await act(async () => props(button("Up")).onClick());
    expect(listFiles).toHaveBeenLastCalledWith("remote-1", "/unknown");
    expect(props(button("Upload")).disabled).toBe(false);
  } finally { await act(async () => root.unmount()); }
});

it("ignores a previous session listing that finishes after the new session", async () => {
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  let finishFirst!: (directory: RemoteDirectory) => void;
  const listFiles = vi.fn().mockImplementationOnce(() => new Promise<RemoteDirectory>(resolve => { finishFirst = resolve; }))
    .mockResolvedValue({ path: "/second", entries: [] });
  const remote = { listFiles, transfers: {} } as unknown as RemoteApi;
  const render = (sessionId: string) => root.render(<I18nProvider locale="en"><RemoteFilesPane session={{ sessionId, fileRootLabel: "Shared" } as RemoteSessionSummary} remote={remote} /></I18nProvider>);
  const path = () => allNodes(host).find(node => node.tagName === "INPUT" && props(node).type !== "file")!.value;
  try {
    await act(async () => render("first"));
    await act(async () => render("second"));
    expect(path()).toBe("/second");
    await act(async () => finishFirst({ path: "/first", entries: [] } as RemoteDirectory));
    expect(path()).toBe("/second");
  } finally { await act(async () => root.unmount()); }
});
