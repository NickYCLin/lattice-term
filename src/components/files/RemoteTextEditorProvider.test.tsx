import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { en } from "../../i18n/messages/en";
import { appLifecycleGuard, type AppLifecycleLease } from "../../app/appLifecycleGuard";
import { useAppUpdater, type AppUpdater } from "../../app/useAppUpdater";
import { fakeRemoteApi } from "../../app/testFixtures/agentApis";
import type { RemoteApi, RemoteSessionSummary } from "../../app/useRemoteSessions";
import { useRemoteSessions } from "../../app/useRemoteSessions";
import type { SftpApi, SftpSessionSummary } from "../../app/useSftpSessions";
import type { RemoteTextEditorProps } from "./RemoteTextEditor";
import { RemoteFilesPane } from "../remote/RemoteFilesPane";
import { SftpPane } from "../sftp/SftpPane";
import { RemoteTextEditorProvider, useRemoteTextEditor } from "./RemoteTextEditorProvider";

const editor = vi.hoisted(() => ({
  props: null as RemoteTextEditorProps | null,
  mounts: 0,
  unmounts: 0,
  draft: "",
  edit: null as ((value: string) => void) | null,
}));
const backend = vi.hoisted(() => ({
  invoke: vi.fn(),
  checkUpdate: vi.fn(),
  installUpdate: vi.fn(),
  listeners: new Map<string, (event: { payload: Record<string, unknown> }) => void>(),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: backend.checkUpdate }));
vi.mock("../overlays/modalFocus", () => ({ useModalFocus: () => {} }));
vi.mock("react-dom", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-dom")>(),
  createPortal: (children: unknown) => children,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: backend.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: { payload: Record<string, unknown> }) => void) => {
    backend.listeners.set(name, handler);
    return () => { backend.listeners.delete(name); };
  },
}));
vi.mock("./RemoteTextEditor", async () => {
  const { useEffect, useState } = await import("react");
  return {
    RemoteTextEditor: (props: RemoteTextEditorProps) => {
      const [draft, setDraft] = useState("");
      editor.props = props;
      editor.draft = draft;
      editor.edit = setDraft;
      useEffect(() => {
        editor.mounts += 1;
        return () => { editor.unmounts += 1; };
      }, []);
      return null;
    },
  };
});

class HostNode {
  nodeType = 1;
  namespaceURI = "http://www.w3.org/1999/xhtml";
  childNodes: HostNode[] = [];
  parentNode: HostNode | null = null;
  style = {};
  attributes: Record<string, string> = {};
  ownerDocument: Record<string, unknown>;
  private text = "";
  constructor(readonly tagName: string, document: Record<string, unknown>) { this.ownerDocument = document; }
  get nodeName() { return this.tagName; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get textContent(): string { return this.text + this.childNodes.map((child) => child.textContent).join(""); }
  set textContent(value: string) { this.text = value; this.childNodes = []; }
  appendChild(child: HostNode) { this.childNodes.push(child); child.parentNode = this; return child; }
  removeChild(child: HostNode) { this.childNodes = this.childNodes.filter((node) => node !== child); child.parentNode = null; return child; }
  insertBefore(child: HostNode, before: HostNode) { this.childNodes.splice(this.childNodes.indexOf(before), 0, child); child.parentNode = this; return child; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  setAttributeNS(_namespace: string, name: string, value: string) { this.setAttribute(name, value); }
  removeAttribute(name: string) { delete this.attributes[name]; }
  addEventListener() {}
  removeEventListener() {}
  focus() {}
}

function nodes(node: HostNode): HostNode[] { return [node, ...node.childNodes.flatMap(nodes)]; }
function props(node: HostNode): { onClick: () => void; disabled: boolean; inert: boolean } {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"))!;
  return (node as unknown as Record<string, ReturnType<typeof props>>)[key];
}

const remoteSession: RemoteSessionSummary = {
  sessionId: "remote-editor", profileId: "profile-editor", host: "host.example", port: 54921,
  viaRelay: false, agentName: "Test host", width: 0, height: 0, viewOnly: true,
  fileTransfer: true, fileEdit: true, fileRootLabel: "Shared", terminal: true, frame: null,
};
const sftpSession: SftpSessionSummary = {
  sessionId: "sftp-editor", profileId: "profile-editor", host: "host.example", port: 22,
  username: "test-user", currentPath: "/",
};
const entries = ["file", "directory", "symlink", "other"].map((kind) => ({
  name: `${kind}.txt`, path: `/${kind}.txt`, kind, size: 10, modifiedAt: null, permissions: "rw-------",
}));

describe("remote editor integration", () => {
  let host: HostNode;
  let root: Root;
  let api: ReturnType<typeof useRemoteTextEditor>;
  let remote: RemoteApi;
  let sftp: SftpApi;
  let updater: AppUpdater;
  let leases: AppLifecycleLease[];

  beforeEach(() => {
    const document: Record<string, unknown> = { nodeType: 9, activeElement: null, addEventListener() {}, removeEventListener() {} };
    document.createElement = (name: string) => new HostNode(name.toUpperCase(), document);
    document.createElementNS = (_namespace: string, name: string) => new HostNode(name.toUpperCase(), document);
    document.createTextNode = (text: string) => { const node = new HostNode("#text", document); node.nodeType = 3; node.textContent = text; return node; };
    host = new HostNode("DIV", document);
    document.documentElement = host;
    document.body = host;
    const window = { document, HTMLIFrameElement: class {} };
    document.defaultView = window;
    vi.stubGlobal("document", document);
    vi.stubGlobal("window", window);
    vi.stubGlobal("HTMLElement", HostNode);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    editor.mounts = 0;
    editor.unmounts = 0;
    editor.props = null;
    editor.edit = null;
    editor.draft = "";
    backend.invoke.mockReset();
    backend.listeners.clear();
    backend.installUpdate.mockReset();
    backend.checkUpdate.mockReset().mockResolvedValue({ version: "99.0.0", downloadAndInstall: backend.installUpdate });
    leases = [];
    const acquire = appLifecycleGuard.acquire.bind(appLifecycleGuard);
    vi.spyOn(appLifecycleGuard, "acquire").mockImplementation((owner) => {
      const lease = acquire(owner);
      if (lease) leases.push(lease);
      return lease;
    });
    remote = fakeRemoteApi({ listFiles: vi.fn(async () => ({ path: "/", entries }) as never) });
    sftp = {
      transfers: {},
      list: vi.fn(async () => ({ path: "/", entries })),
      readTextFile: vi.fn(async () => ({ path: "/file.txt", content: "file", revision: "rev" })),
      saveTextFile: vi.fn(async () => ({ path: "/file.txt", content: "saved", revision: "next" })),
    } as unknown as SftpApi;
    root = createRoot(host as unknown as Element);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    for (const lease of leases) lease.release();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function Probe() { api = useRemoteTextEditor(); return null; }
  function UpdaterProbe() { updater = useAppUpdater("2.0.0"); return null; }
  async function render(pane: "remote" | "sftp" | null, fileEdit: boolean | undefined = true) {
    await act(async () => root.render(
      <I18nProvider locale="en"><RemoteTextEditorProvider>
        <Probe />
        <UpdaterProbe />
        {pane === "remote" && <RemoteFilesPane session={{ ...remoteSession, fileEdit }} remote={remote} />}
        {pane === "sftp" && <SftpPane session={sftpSession} sftp={sftp} active={false} />}
      </RemoteTextEditorProvider></I18nProvider>,
    ));
  }
  const editButtons = () => nodes(host).filter((node) => node.attributes["aria-label"] === "Edit text");

  it("never asks the SFTP backend for two listings at once, even when effects run twice", async () => {
    // The backend allows one listing per session and rejects a second.
    let running = 0;
    let peak = 0;
    sftp.list = vi.fn(async () => {
      if (running > 0) throw new Error("A directory listing is already running for this session.");
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((done) => setTimeout(done, 5));
      running -= 1;
      return { path: "/", entries };
    }) as SftpApi["list"];
    await act(async () => root.render(
      <StrictMode><I18nProvider locale="en"><RemoteTextEditorProvider>
        <SftpPane session={sftpSession} sftp={sftp} active={false} />
      </RemoteTextEditorProvider></I18nProvider></StrictMode>,
    ));
    await act(async () => { await new Promise((done) => setTimeout(done, 30)); });
    expect(vi.mocked(sftp.list).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(peak).toBe(1);
    expect(host.textContent).not.toContain("already running");
    expect(host.textContent).toContain("file.txt");
  });

  it("keeps a single editor and its in-memory draft when the owning pane disconnects", async () => {
    await render("remote");
    await act(async () => props(editButtons()[0]).onClick());
    expect(api!.active).toBe(true);
    expect(nodes(host).some((node) => props(node)?.inert === true)).toBe(true);
    expect(editor.mounts).toBe(1);
    await act(async () => editor.edit!("unsaved draft"));
    await render(null);
    expect(editor.unmounts).toBe(0);
    expect(editor.draft).toBe("unsaved draft");
    expect(editor.props?.path).toBe("/file.txt");
    const listCalls = vi.mocked(remote.listFiles).mock.calls.length;
    await act(async () => editor.props!.onClose());
    expect(editor.unmounts).toBe(1);
    expect(api!.active).toBe(false);
    expect(nodes(host).some((node) => props(node)?.inert === true)).toBe(false);
    expect(remote.listFiles).toHaveBeenCalledTimes(listCalls);
  });

  it("does not replace a draft when another file is requested and preserves session binding", async () => {
    await render("sftp");
    await act(async () => props(editButtons()[0]).onClick());
    await act(async () => editor.edit!("original draft"));
    const request = editor.props!;
    await render("remote");
    await act(async () => api.open({ path: "/different.txt", read: vi.fn(), save: vi.fn() }));
    expect(editor.mounts).toBe(1);
    expect(editor.draft).toBe("original draft");
    expect(editor.props?.path).toBe("/file.txt");
    await request.read();
    await request.save("changed", "expected-revision", true);
    expect(sftp.readTextFile).toHaveBeenCalledExactlyOnceWith("sftp-editor", "/file.txt");
    expect(sftp.saveTextFile).toHaveBeenCalledExactlyOnceWith("sftp-editor", "/file.txt", "changed", "expected-revision", true);
    expect(remote.readTextFile).not.toHaveBeenCalled();
    expect(remote.saveTextFile).not.toHaveBeenCalled();
  });

  it.each([undefined, false])("does not offer remote editing without a negotiated capability: %s", async (fileEdit) => {
    // Pass an object spread below because the helper's default is true.
    await act(async () => root.render(<I18nProvider locale="en"><RemoteTextEditorProvider>
      <Probe /><RemoteFilesPane session={{ ...remoteSession, fileEdit }} remote={remote} />
    </RemoteTextEditorProvider></I18nProvider>));
    expect(editButtons()).toHaveLength(0);
    expect(host.textContent).toContain(en["fileEditor.unsupportedHost"]);
    expect(remote.readTextFile).not.toHaveBeenCalled();
  });

  it.each(["remote", "sftp"] as const)("offers editing for regular %s files only and refreshes after close", async (pane) => {
    await render(pane);
    expect(editButtons()).toHaveLength(1);
    expect(host.textContent).not.toContain(en["fileEditor.unsupportedHost"]);
    const listing = pane === "remote" ? remote.listFiles : sftp.list;
    expect(listing).toHaveBeenCalledTimes(1);
    await act(async () => props(editButtons()[0]).onClick());
    expect(props(editButtons()[0]).disabled).toBe(true);
    expect(editor.props?.path).toBe("/file.txt");
    await act(async () => editor.props!.onClose());
    expect(listing).toHaveBeenCalledTimes(2);
  });

  it.each([true, false, undefined])("preserves negotiated file editing through hydration, connect and frame updates: %s", async (fileEdit) => {
    let runtime: RemoteApi | null = null;
    function RuntimeProbe() { runtime = useRemoteSessions(); return null; }
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_sessions") return [{ ...remoteSession, fileEdit }];
      if (command === "remote_connect") return { ...remoteSession, sessionId: "new-session", fileEdit, outcome: "connected", terminal: false };
      return [];
    });
    await act(async () => root.render(<RuntimeProbe />));
    const current = () => runtime as unknown as RemoteApi;
    expect(current().sessions[0].fileEdit).toBe(fileEdit);
    await act(async () => { await current().connect({
      profileId: "profile-editor", hostname: "host.example", port: 54921, pairingCode: "test-only",
    }); });
    expect(current().sessions.find((session) => session.sessionId === "new-session")?.fileEdit).toBe(fileEdit);
    await act(async () => backend.listeners.get("remote://frame")!({ payload: {
      sessionId: "new-session", frameId: 1, width: 100, height: 100, mimeType: "image/png", base64: "",
    } }));
    const session = current().sessions.find((value) => value.sessionId === "new-session")!;
    expect(session.fileEdit).toBe(fileEdit);
    expect(session.frame?.frameId).toBe(1);
    await current().readTextFile("new-session", "/file.txt");
    await current().saveTextFile("new-session", "/file.txt", "draft", "revision");
    expect(backend.invoke).toHaveBeenCalledWith("remote_file_read_text", { sessionId: "new-session", path: "/file.txt" });
    expect(backend.invoke).toHaveBeenCalledWith("remote_file_save_text", {
      sessionId: "new-session", path: "/file.txt", content: "draft", revision: "revision",
    });
  });

  it("blocks installation synchronously when the editor opens in the same tick", async () => {
    await render("remote");
    await act(async () => { await updater.checkForUpdates(); });
    await act(async () => {
      api.open({ path: "/draft.txt", read: vi.fn(), save: vi.fn() });
      await updater.downloadAndInstall();
    });
    expect(backend.installUpdate).not.toHaveBeenCalled();
    expect(backend.invoke).not.toHaveBeenCalled();
    expect(updater!.error).toBe(en["settings.updater.editorBlocked"]);
    expect(appLifecycleGuard.owner).toBe("editor");
    await act(async () => editor.props!.onClose());
    expect(appLifecycleGuard.owner).toBeNull();
  });

  it("blocks drafts throughout a background download, tab changes, and accepted restart", async () => {
    let finishDownload!: () => void;
    backend.installUpdate.mockImplementation(() => new Promise<void>((resolve) => { finishDownload = resolve; }));
    await render("remote");
    await act(async () => { await updater.checkForUpdates(); });
    let pending!: Promise<void>;
    await act(async () => {
      pending = updater.downloadAndInstall();
      api.open({ path: "/draft.txt", read: vi.fn(), save: vi.fn() });
    });
    expect(editor.mounts).toBe(0);
    expect(host.textContent).toContain(en["fileEditor.updateBlockedBody"]);
    expect(appLifecycleGuard.owner).toBe("update");
    await render("sftp");
    await act(async () => api.open({ path: "/another.txt", read: vi.fn(), save: vi.fn() }));
    expect(editor.mounts).toBe(0);
    await act(async () => { finishDownload(); await pending; });
    expect(backend.invoke).toHaveBeenCalledWith("app_restart_safely");
    expect(appLifecycleGuard.owner).toBe("update");
    await act(async () => root.render(null));
    expect(appLifecycleGuard.owner).toBe("update");
    expect(appLifecycleGuard.acquire("editor")).toBeNull();
  });

  it("releases failed installation ownership so an editor can open", async () => {
    backend.installUpdate.mockRejectedValueOnce(new Error("signature rejected"));
    await render("remote");
    await act(async () => { await updater.checkForUpdates(); });
    await act(async () => { await updater.downloadAndInstall(); });
    expect(updater!.status).toBe("error");
    expect(appLifecycleGuard.owner).toBeNull();
    expect(backend.invoke).not.toHaveBeenCalled();
    await act(async () => api.open({ path: "/draft.txt", read: vi.fn(), save: vi.fn() }));
    expect(editor.mounts).toBe(1);
    expect(appLifecycleGuard.owner).toBe("editor");
    await act(async () => root.render(null));
    expect(appLifecycleGuard.owner).toBeNull();
  });

  it("protects restart retries without requiring an editor or locale provider", async () => {
    await act(async () => root.render(<UpdaterProbe />));
    const draft = appLifecycleGuard.acquire("editor")!;
    await act(async () => { await updater.relaunchApp(); });
    expect(backend.invoke).not.toHaveBeenCalled();
    expect(updater!.error).toContain("請先儲存或捨棄遠端檔案草稿");
    draft.release();
    backend.invoke.mockRejectedValueOnce(new Error("restart failed"));
    await act(async () => { await updater.relaunchApp(); });
    expect(updater!.status).toBe("downloaded");
    expect(appLifecycleGuard.owner).toBeNull();
    await act(async () => { await updater.relaunchApp(); });
    expect(appLifecycleGuard.owner).toBe("update");
  });
});
