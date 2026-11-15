import { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { allNodes, installHostDom, props } from "../agents/testFixtures/interactionDom";
import { useComposerAssistance } from "./ComposerAssistance";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
async function setup(filesEnabled = true) {
  const host = installHostDom(); const root = createRoot(host as unknown as Element);
  const model = vi.fn(); const file = vi.fn(() => true);
  function Probe() {
    const [draft, setDraft] = useState(""); const inputRef = useRef<HTMLTextAreaElement>(null);
    const assistance = useComposerAssistance({ draft, onText: setDraft, inputRef, workingDirectory: "/synthetic", filesEnabled,
      onFile: file, commands: { model } });
    return <><textarea ref={inputRef} value={draft} onFocus={assistance.reopen} onBlur={assistance.dismiss}
      onChange={event => { setDraft(event.target.value); assistance.select(event.target.selectionStart); }}
      onKeyDown={assistance.keyDown} />{assistance.menu}</>;
  }
  await act(async () => { root.render(<I18nProvider locale="zh-TW"><Probe /></I18nProvider>); });
  const input = () => allNodes(host).find(node => node.tagName === "TEXTAREA")!;
  const type = async (value: string) => { await act(async () => { props(input()).onFocus(); props(input()).onChange({ target: { value, selectionStart: value.length } }); }); };
  const key = async (key: string, composing = false) => {
    const event = { key, shiftKey: false, nativeEvent: { isComposing: composing }, preventDefault: vi.fn() };
    let handled: boolean | undefined;
    await act(async () => { handled = props(input()).onKeyDown(event); });
    return { event, handled };
  };
  return { host, root, model, file, input, type, key };
}
it("selects a slash action with the keyboard while respecting IME and disabled native actions", async () => {
  const runtime = await setup();
  try {
    await runtime.type("/mo");
    expect(allNodes(runtime.host).filter(node => props(node)?.role === "option")).toHaveLength(1);
    expect((await runtime.key("Enter", true)).handled).toBe(false);
    expect(runtime.model).not.toHaveBeenCalled();
    expect((await runtime.key("Enter")).handled).toBe(true);
    expect(runtime.model).toHaveBeenCalledTimes(1);
    expect(runtime.input().value).toBe("");
    await runtime.type("/compact");
    await runtime.key("Enter");
    expect(runtime.input().value).toBe("/compact");
    expect(runtime.host.textContent).toContain("尚不提供");
    await runtime.key("Escape");
    expect((await runtime.key("Enter")).handled).toBe(false);
  } finally { await act(async () => { runtime.root.unmount(); }); }
});
it("does not submit an unresolved file token and ignores stale search results", async () => {
  vi.useFakeTimers();
  let old!: (result: unknown) => void;
  const stale = new Promise(resolve => { old = resolve; });
  invoke.mockImplementation((_command, args) => args.query === "old" ? stale : Promise.resolve({ files: [{ path: "src/new.ts", absolutePath: "/synthetic/src/new.ts" }], truncated: false }));
  const runtime = await setup();
  try {
    await runtime.type("@old");
    expect((await runtime.key("Enter")).handled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    await runtime.type("@new");
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    expect(runtime.host.textContent).toContain("src/new.ts");
    await act(async () => { old({ files: [{ path: "src/old.ts", absolutePath: "/synthetic/src/old.ts" }], truncated: false }); await stale; });
    expect(runtime.host.textContent).not.toContain("src/old.ts");
    await runtime.key("Enter");
    expect(runtime.input().value).toBe("@src/new.ts ");
    expect(runtime.file).toHaveBeenCalledWith({ path: "src/new.ts", absolutePath: "/synthetic/src/new.ts" });
  } finally { await act(async () => { runtime.root.unmount(); }); }
});
it("does not scan a local directory for a source without file tools", async () => {
  vi.useFakeTimers(); const runtime = await setup(false);
  try {
    await runtime.type("@");
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(invoke).not.toHaveBeenCalled();
    expect(runtime.host.textContent).toContain("沒有本機檔案工具");
    expect((await runtime.key("Enter")).handled).toBe(true);
  } finally { await act(async () => { runtime.root.unmount(); }); }
});
