import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { installFakeDom } from "../../app/testFixtures/hookDom";
import { AgentAccountProfileDialog } from "./AgentAccountProfileDialog";

const { open } = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open }));
vi.mock("../overlays/modalFocus", () => ({ useModalFocus: () => {} }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

type Host = Record<string, unknown> & { childNodes?: Host[] };
type Props = { children?: unknown; onClick?: () => void; onSubmit?: (event: { preventDefault: () => void }) => void };
function hostProps(root: Host): Props[] {
  const key = Object.keys(root).find(name => name.startsWith("__reactProps$"));
  return [...(key ? [root[key] as Props] : []), ...(root.childNodes ?? []).flatMap(hostProps)];
}

it("links default or selected native history without requiring a new account login", async () => {
  const container = installFakeDom();
  const document = globalThis.document;
  document.createElementNS = ((_namespace: string | null, name: string) => document.createElement(name)) as typeof document.createElementNS;
  const onSave = vi.fn(async () => {});
  const root = createRoot(container as unknown as Element);
  const click = async (label: string) => {
    const props = hostProps(container).find(props => props.children === label && props.onClick);
    expect(props).toBeDefined();
    await act(async () => props!.onClick!());
  };
  const submit = async () => {
    const form = hostProps(container).find(props => props.onSubmit)!;
    await act(async () => form.onSubmit!({ preventDefault() {} }));
  };
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><AgentAccountProfileDialog agentLabel="OpenAI Codex" onSave={onSave} onCancel={() => {}} /></I18nProvider>));
    await submit();
    expect(onSave).not.toHaveBeenCalled();
    await click("共用原生工具紀錄（雙向）");
    await submit();
    expect(onSave).toHaveBeenLastCalledWith("OpenAI Codex", "");
    expect(open).not.toHaveBeenCalled();
    open.mockResolvedValueOnce("C:/native/codex");
    await click("選擇其他原生紀錄目錄…");
    expect(open).toHaveBeenCalledWith({ directory: true, multiple: false });
    await submit();
    expect(onSave).toHaveBeenLastCalledWith("OpenAI Codex", "C:/native/codex");
    open.mockResolvedValueOnce(null);
    await click("選擇其他原生紀錄目錄…");
    await submit();
    expect(onSave).toHaveBeenLastCalledWith("OpenAI Codex", "C:/native/codex");
    await click("改用預設目錄");
    await submit();
    expect(onSave).toHaveBeenLastCalledWith("OpenAI Codex", "");
  } finally {
    await act(async () => root.unmount());
  }
});
