import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { allNodes, installHostDom, props } from "../agents/testFixtures/interactionDom";
import { I18nProvider } from "../../i18n";
import { OpenEditorButton } from "./OpenEditorButton";

const { invoke, backend } = vi.hoisted(() => ({ invoke: vi.fn(), backend: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../../app/nativeRuntime", () => ({ hasDesktopBackend: backend }));
afterEach(() => { vi.unstubAllGlobals(); invoke.mockReset(); backend.mockReturnValue(true); });
const render = (directory = "/synthetic/project") => <I18nProvider locale="zh-TW"><OpenEditorButton directory={directory} /></I18nProvider>;

it("opens only after an explicit click, passing the literal directory once for same-turn double clicks", async () => {
  const host = installHostDom(); const root = createRoot(host as unknown as Element);
  let done!: () => void; invoke.mockImplementation(() => new Promise<void>(resolve => { done = resolve; }));
  try {
    await act(async () => root.render(render("/synthetic/space & '$x'")));
    expect(invoke).not.toHaveBeenCalled();
    const click = props(allNodes(host).find(node => node.tagName === "BUTTON")!)!.onClick as () => void;
    await act(async () => { click(); click(); });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("chat_open_editor", { workingDirectory: "/synthetic/space & '$x'" });
    await act(async () => done());
    expect(host.textContent).toContain("已送出 VS Code 開啟要求");
  } finally { await act(async () => root.unmount()); }
});

it("shows a localized failure and allows a retry without exposing raw process errors", async () => {
  const host = installHostDom(); const root = createRoot(host as unknown as Element);
  invoke.mockRejectedValueOnce("chat.editor.unavailable").mockResolvedValueOnce(undefined);
  try {
    await act(async () => root.render(render()));
    const click = () => (props(allNodes(host).find(node => node.tagName === "BUTTON")!)!.onClick as () => void)();
    await act(async () => click());
    expect(host.textContent).toContain("找不到 VS Code");
    expect(host.textContent).not.toContain("chat.editor.unavailable");
    await act(async () => click());
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("已送出 VS Code 開啟要求");
  } finally { await act(async () => root.unmount()); }
});

it("does not show an old folder's delayed result after the selected folder changes", async () => {
  const host = installHostDom(); const root = createRoot(host as unknown as Element);
  let done!: () => void; invoke.mockImplementationOnce(() => new Promise<void>(resolve => { done = resolve; }));
  try {
    await act(async () => root.render(render()));
    await act(async () => (props(allNodes(host).find(node => node.tagName === "BUTTON")!)!.onClick as () => void)());
    await act(async () => root.render(render("/synthetic/other")));
    await act(async () => done());
    expect(host.textContent).not.toContain("已送出");
  } finally { await act(async () => root.unmount()); }
});
