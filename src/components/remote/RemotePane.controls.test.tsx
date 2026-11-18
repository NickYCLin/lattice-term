import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { RemoteApi, RemoteSessionSummary } from "../../app/useRemoteSessions";
import { allNodes, installHostDom, props } from "../agents/testFixtures/interactionDom";
import { RemotePane } from "./RemotePane";
vi.mock("./RemoteCliPane", () => ({ RemoteCliPane: () => <div data-pane="cli"><textarea /></div> }));
vi.mock("./RemoteChatPane", () => ({ RemoteChatPane: ({ hidden }: { hidden: boolean }) => <div data-pane="chat" hidden={hidden} /> }));
vi.mock("./RemoteCommandPane", () => ({ RemoteCommandPane: ({ hidden }: { hidden: boolean }) => <div data-pane="commands" hidden={hidden} /> }));
vi.mock("./RemoteFilesPane", () => ({ RemoteFilesPane: () => <div data-pane="files" /> }));
vi.mock("./CanvasSoftKeyboard", async original => ({ ...await original<typeof import("./CanvasSoftKeyboard")>(), CanvasSoftKeyboard: () => null }));
vi.mock("./CanvasCaptureControls", () => ({ CanvasCaptureControls: () => null }));
afterEach(() => vi.unstubAllGlobals());
it("switches all remote header panels, prevents pointer focus and does not type commands", async () => {
  const host = installHostDom(), root = createRoot(host as unknown as Element);
  const input = vi.fn(async () => {});
  const session = { sessionId: "synthetic", agentName: "Synthetic host", viewOnly: false, terminal: false, frame: null,
    width: 1280, height: 720, cli: true, chat: true, fileTransfer: true, commandShells: 1 } as unknown as RemoteSessionSummary;
  const remote = { input } as unknown as RemoteApi;
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><RemotePane session={session} remote={remote} theme="dark" /></I18nProvider>));
    const toolbar = allNodes(host).find(n => props(n)?.className === "remote-toolbar")!;
    const buttons = allNodes(toolbar).filter(n => n.tagName === "BUTTON");
    expect(buttons).toHaveLength(4);
    for (const [label, pane] of [["對話", "chat"], ["助理", "cli"], ["主機檔案", "files"], ["命令", "commands"]]) {
      const button = buttons.find(n => n.textContent === label)!;
      const preventDefault = vi.fn(); props(toolbar).onPointerDown({ target: { closest: () => button }, preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
      await act(async () => props(button).onClick());
      expect(props(button)["aria-pressed"]).toBe(true);
      const shown = allNodes(host).find(n => props(n)?.["data-pane"] === pane)!;
      expect(shown).toBeDefined(); expect(props(shown).hidden).not.toBe(true);
      expect(buttons.filter(n => props(n)["aria-pressed"] === true)).toHaveLength(1);
    }
    expect(input).not.toHaveBeenCalled();
    const files = buttons.find(n => n.textContent === "主機檔案")!;
    await act(async () => props(files).onClick());
    await act(async () => props(files).onClick());
    expect(props(files)["aria-pressed"]).toBe(false);
    expect(allNodes(host).some(n => props(n)?.["data-pane"] === "files")).toBe(false);
  } finally { await act(async () => root.unmount()); }
});
