import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { SftpApi, SftpEntry, SftpSessionSummary } from "../../app/useSftpSessions";
import type { RemoteApi, RemoteSessionSummary } from "../../app/useRemoteSessions";
import { allNodes, installHostDom, props } from "../agents/testFixtures/interactionDom";
import { SftpPane } from "../sftp/SftpPane";
import { RemoteFilesPane } from "../remote/RemoteFilesPane";
import { filterFileNames } from "./FileNameFilter";

const { confirm } = vi.hoisted(() => ({ confirm: vi.fn() }));
vi.mock("../../app/fileDrop", () => ({ useFileDrop: vi.fn(() => ({ dragging: false })) }));
vi.mock("../files/RemoteTextEditorProvider", () => ({ useRemoteTextEditor: () => ({ active: false, open: vi.fn() }) }));
vi.mock("../overlays/useAppDialogs", () => ({ useAppDialogs: () => ({ confirm, prompt: vi.fn(), dialogs: null }) }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("matches literal names without changing the source order or entries", () => {
  const entries = [{ name: "報表.TXT" }, { name: "[draft].txt" }, { name: "Other" }];
  expect(filterFileNames(entries, " 報表.txt ")).toEqual([entries[0]]);
  expect(filterFileNames(entries, "[draft]")).toEqual([entries[1]]);
  expect(filterFileNames(entries, "  ")).toBe(entries);
  expect(entries).toHaveLength(3);
});

it.each(["sftp", "remote"] as const)("filters %s locally, preserves refresh, clears on navigation and still checks hidden collisions", async kind => {
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  const entries: SftpEntry[] = [
    { name: "Reports", path: "/Reports", kind: "directory", size: 0, modifiedAt: null, permissions: "drwxr-xr-x" },
    { name: "報表.TXT", path: "/報表.TXT", kind: "file", size: 1, modifiedAt: null, permissions: "-rw-r--r--" },
    { name: "hidden.txt", path: "/hidden.txt", kind: "file", size: 1, modifiedAt: null, permissions: "-rw-r--r--" },
  ];
  const list = vi.fn(async (_sessionId: string, path: string) => ({ path, entries }));
  const upload = vi.fn();
  const download = vi.fn();
  const sftp = { list, uploadStream: upload, downloadToDisk: download, transfers: {} } as unknown as SftpApi;
  const remote = { listFiles: list, uploadFile: upload, downloadFile: download, transfers: {} } as unknown as RemoteApi;
  const render = (sessionId: string) => root.render(<I18nProvider locale="en">{kind === "sftp"
    ? <SftpPane session={{ sessionId, currentPath: "/" } as SftpSessionSummary} sftp={sftp} />
    : <RemoteFilesPane session={{ sessionId, fileEdit: true, fileRootLabel: "Shared" } as RemoteSessionSummary} remote={remote} />}</I18nProvider>);
  const search = () => allNodes(host).find(node => node.tagName === "INPUT" && props(node).type === "search")!;
  const filter = async (value: string) => { await act(async () => props(search()).onChange({ currentTarget: { value } })); };
  const rows = () => allNodes(host).filter(node => node.tagName === "TBODY").map(node => node.textContent).join("");
  try {
    await act(async () => render("first"));
    await filter(" 報表.txt ");
    expect(rows()).toContain("報表.TXT");
    expect(rows()).not.toContain("hidden.txt");
    expect(list).toHaveBeenCalledTimes(1);
    await act(async () => props(allNodes(host).find(node => node.tagName === "BUTTON" && node.textContent === "報表.TXT")!).onClick());
    expect(download).toHaveBeenCalledWith("first", "/報表.TXT");
    confirm.mockResolvedValue(false);
    await act(async () => props(allNodes(host).find(node => node.tagName === "INPUT" && props(node).type === "file")!).onChange({ currentTarget: { files: [{ name: "hidden.txt", size: 1 }] } }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(upload).not.toHaveBeenCalled();
    await filter("missing");
    expect(host.textContent).toContain("No matching file names");
    await act(async () => props(allNodes(host).find(node => node.tagName === "BUTTON" && node.textContent === "Clear")!).onClick());
    expect(rows()).toContain("hidden.txt");
    await filter("Reports");
    await act(async () => props(allNodes(host).find(node => node.tagName === "BUTTON" && (props(node)["aria-label"] === "Refresh" || node.textContent === "Refresh"))!).onClick());
    expect(search().value).toBe("Reports");
    await act(async () => props(allNodes(host).find(node => node.tagName === "BUTTON" && node.textContent === "Reports")!).onClick());
    expect(list).toHaveBeenLastCalledWith("first", "/Reports");
    expect(search().value).toBe("");
    await filter("missing");
    await act(async () => render("second"));
    expect(search().value).toBe("");
  } finally { await act(async () => root.unmount()); }
});

it.each(["sftp", "remote"] as const)("disables %s filtering during listing and distinguishes an empty folder", async kind => {
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  let finish!: (value: { path: string; entries: [] }) => void;
  const list = vi.fn(() => new Promise<{ path: string; entries: [] }>(resolve => { finish = resolve; }));
  try {
    await act(async () => root.render(<I18nProvider locale="en">{kind === "sftp"
      ? <SftpPane session={{ sessionId: "empty", currentPath: "/" } as SftpSessionSummary} sftp={{ list, transfers: {} } as unknown as SftpApi} />
      : <RemoteFilesPane session={{ sessionId: "empty", fileRootLabel: "Shared" } as RemoteSessionSummary} remote={{ listFiles: list, transfers: {} } as unknown as RemoteApi} />}</I18nProvider>));
    const search = () => allNodes(host).find(node => node.tagName === "INPUT" && props(node).type === "search")!;
    expect(props(search()).disabled).toBe(true);
    await act(async () => finish({ path: "/", entries: [] }));
    expect(props(search()).disabled).toBe(false);
    await act(async () => props(search()).onChange({ currentTarget: { value: "anything" } }));
    expect(host.textContent).toContain("This folder is empty.");
    expect(host.textContent).not.toContain("No matching file names");
    expect(list).toHaveBeenCalledTimes(1);
  } finally { await act(async () => root.unmount()); }
});
