import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installFakeDom } from "../../app/testFixtures/hookDom";
import { I18nProvider } from "../../i18n";
import { AgentAccountProfileDialog } from "./AgentAccountProfileDialog";

const { openDirectory, modalFocus } = vi.hoisted(() => ({ openDirectory: vi.fn(), modalFocus: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openDirectory }));
vi.mock("../overlays/modalFocus", () => ({ useModalFocus: modalFocus }));

type HostNode = { childNodes?: HostNode[]; [key: string]: unknown };
function hostProps(node: HostNode): Record<string, unknown>[] {
  const key = Object.keys(node).find(candidate => candidate.startsWith("__reactProps$"));
  return [...(key ? [node[key] as Record<string, unknown>] : []), ...(node.childNodes ?? []).flatMap(hostProps)];
}

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("AgentAccountProfileDialog", () => {
  it.each(["OpenAI Codex", "Claude Code"])("adds %s with only a name and a sign-in action", (agentLabel) => {
    const markup = renderToStaticMarkup(
      <I18nProvider locale="zh-TW">
        <AgentAccountProfileDialog
          agentLabel={agentLabel}
          onSave={vi.fn()}
          onCancel={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain(`新增另一個 ${agentLabel} 帳號`);
    expect(markup).toContain("加入後會開啟終端機");
    expect(markup).toContain("帳號名稱");
    expect(markup).toContain("加入並登入");
    expect(markup).toContain("共用原生工具紀錄（雙向）");
    expect(markup.match(/<input\b/g)).toHaveLength(1);
    expect(markup).toContain("無需選擇資料夾");
    expect(markup).not.toContain("選擇設定目錄");
    expect(markup).not.toContain("<details");
    expect(markup).not.toContain("CODEX_HOME");
    expect(markup).not.toContain("CLAUDE_CONFIG_DIR");
  });
});

it.each(["selected", "cancelled", "failed"])("waits for the directory picker before linking an account (%s)", async mode => {
  const container = installFakeDom();
  document.createElementNS = ((_namespace: string | null, name: string) => document.createElement(name)) as typeof document.createElementNS;
  let finishPicker!: (value: string | null) => void;
  let failPicker!: (reason: Error) => void;
  openDirectory.mockReturnValueOnce(new Promise<string | null>((resolve, reject) => { finishPicker = resolve; failPicker = reject; }));
  const onSave = vi.fn(async () => {});
  const onCancel = vi.fn();
  const root = createRoot(container as unknown as Element);
  const props = () => hostProps(container as unknown as HostNode);
  try {
    await act(async () => { root.render(<I18nProvider locale="zh-TW"><AgentAccountProfileDialog agentLabel="OpenAI Codex" onSave={onSave} onCancel={onCancel} /></I18nProvider>); });
    const sharedButton = props().find(entry => entry["aria-pressed"] === false)!;
    await act(async () => { (sharedButton.onClick as () => void)(); });
    const pickerButton = props().find(entry => typeof entry.onClick === "function" && String(entry.children).includes("選擇") && String(entry.children).includes("目錄"))!;
    expect(pickerButton).toBeDefined();
    const submit = props().find(entry => typeof entry.onSubmit === "function")!.onSubmit as (event: unknown) => void;
    await act(async () => {
      (pickerButton.onClick as () => void)();
      submit({ preventDefault: vi.fn() });
      await vi.dynamicImportSettled();
    });
    expect(onSave).not.toHaveBeenCalled();
    expect(props().find(entry => entry.role === "dialog")!["aria-busy"]).toBe(true);
    expect(props().filter(entry => typeof entry.onClick === "function").every(entry => entry.disabled === true)).toBe(true);
    expect(props().find(entry => entry.type === "submit")!.disabled).toBe(true);
    expect(modalFocus.mock.lastCall![0].escapeDisabled).toBe(true);
    await act(async () => { (props().find(entry => entry.role === "presentation")!.onMouseDown as () => void)(); });
    expect(onCancel).not.toHaveBeenCalled();
    await act(async () => { (pickerButton.onClick as () => void)(); await vi.dynamicImportSettled(); });
    expect(openDirectory).toHaveBeenCalledTimes(1);
    await act(async () => {
      if (mode === "failed") failPicker(new Error("Picker unavailable"));
      else finishPicker(mode === "selected" ? "C:/fixture/selected" : null);
    });
    expect(props().find(entry => entry.type === "submit")!.disabled).toBe(false);
    if (mode === "failed") expect(props().find(entry => entry.role === "alert")!.children).toContain("Picker unavailable");
    await act(async () => { (props().find(entry => typeof entry.onSubmit === "function")!.onSubmit as (event: unknown) => void)({ preventDefault: vi.fn() }); });
    expect(onSave).toHaveBeenCalledExactlyOnceWith("OpenAI Codex", mode === "selected" ? "C:/fixture/selected" : "");
    expect(onCancel).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});
