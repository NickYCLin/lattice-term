import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { allNodes, installHostDom, props } from "../agents/testFixtures/interactionDom";
import { SandboxComputerSetting } from "./SandboxComputerSetting";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

it("shows the saved shared setting and keeps its last confirmed value if saving fails", async () => {
  const host = installHostDom();
  const root = createRoot(host as unknown as HTMLElement);
  const checkbox = () => props(allNodes(host).find(node => node.tagName === "INPUT")!);
  invoke.mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("read-only"));
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><SandboxComputerSetting /></I18nProvider>));
    expect(invoke).toHaveBeenCalledWith("chat_sandbox_preference");
    expect(checkbox().checked).toBe(true);
    await act(async () => checkbox().onChange({ target: { checked: false } }));
    expect(invoke).toHaveBeenCalledWith("chat_sandbox_preference", { enabled: false });
    expect(checkbox().checked).toBe(false);
    await act(async () => checkbox().onChange({ target: { checked: true } }));
    expect(checkbox().checked).toBe(false);
    expect(host.textContent).toContain("read-only");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
