import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { allNodes, installHostDom, props } from "../agents/testFixtures/interactionDom";
import { createConnectionProfile, emptyDraft } from "../../domain/connection";
import { I18nProvider } from "../../i18n";
import { ConnectionDrawer } from "./ConnectionDrawer";
const { useModalFocus } = vi.hoisted(() => ({ useModalFocus: vi.fn() }));
vi.mock("./modalFocus", () => ({ useModalFocus }));
vi.mock("../../app/useConnectionCredentialDraft", () => ({ useConnectionCredentialDraft: () => ({
  native: false, dirty: false, loading: false, secret: "", saved: false, allowMcpRead: false,
  setSecret() {}, setAllowMcpRead() {}, reveal() {}, invalidateReveal() {},
}) }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

it.each([false, true].flatMap(editing => [false, true].flatMap(dirty =>
  ["cancel", "close", "scrim", "escape"].map(exit => ({ editing, dirty, exit })))))(
  "preserves closing and discard confirmation in the centered modal: %j", async ({ editing, dirty, exit }) => {
    const host = installHostDom();
    const root = createRoot(host as unknown as Element);
    const profile = editing ? createConnectionProfile({ ...emptyDraft(), name: "Synthetic", hostname: "host.invalid" }, "synthetic") : null;
    const close = vi.fn();
    const button = (text: string) => allNodes(host).find(node => node.tagName === "BUTTON" && node.textContent === text)!;
    const modalFocus = () => useModalFocus.mock.calls[useModalFocus.mock.calls.length - 1][0];
    const exitModal = async () => act(async () => {
      if (exit === "escape") modalFocus().onEscape();
      else if (exit === "cancel") props(button("取消")).onClick();
      else if (exit === "close") props(allNodes(host).find(node => props(node)?.["aria-label"] === "關閉")!).onClick();
      else props(allNodes(host).find(node => props(node)?.className === "scrim scrim--center connection-modal-scrim")!).onMouseDown();
    });
    try {
      await act(async () => root.render(<I18nProvider locale="zh-TW"><ConnectionDrawer profile={profile} profiles={profile ? [profile] : []}
        supportedProtocols={["ssh"]} mobile={false} onClose={close} onSave={vi.fn()} /></I18nProvider>));
      const panel = allNodes(host).find(node => props(node)?.role === "dialog")!;
      expect(modalFocus().dialogRef.current === panel).toBe(true);
      expect(props(modalFocus().getInitialFocus())["data-field"]).toBe("name");
      const inside = { stopPropagation: vi.fn() };
      props(panel).onMouseDown(inside);
      expect(inside.stopPropagation).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
      if (dirty) {
        const name = allNodes(host).find(node => props(node)?.["data-field"] === "name")!;
        await act(async () => props(name).onChange({ currentTarget: { value: "Edited synthetic name" } }));
      }
      await exitModal();
      if (!dirty) expect(close).toHaveBeenCalledOnce();
      else {
        expect(close).not.toHaveBeenCalled();
        const confirm = allNodes(host).find(node => props(node)?.className === "drawer__foot drawer__foot--confirm")!;
        expect(confirm.parentNode === panel).toBe(true);
        await act(async () => props(button("繼續編輯")).onClick());
        expect(close).not.toHaveBeenCalled();
        expect(props(allNodes(host).find(node => props(node)?.["data-field"] === "name")!).value).toBe("Edited synthetic name");
        await exitModal();
        await act(async () => props(button("放棄修改")).onClick());
        expect(close).toHaveBeenCalledOnce();
      }
    } finally { await act(async () => root.unmount()); }
  });
