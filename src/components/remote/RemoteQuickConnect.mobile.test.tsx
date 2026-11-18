import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { zhTW } from "../../i18n/messages/zh-TW";
import type { RemoteApi } from "../../app/useRemoteSessions";
import { MobilePresentationProvider } from "../common/MobilePresentation";
import { allNodes, installHostDom, props } from "../agents/testFixtures/interactionDom";
import { RemoteQuickConnect } from "./RemoteQuickConnect";
vi.mock("../overlays/modalFocus", () => ({ useModalFocus: () => {} }));
afterEach(() => vi.unstubAllGlobals());
const remote = { sessions: [], connect: vi.fn() } as unknown as RemoteApi;
it.each([false, true])("renders quick-connect explanations only on desktop: mobile=%s", mobile => {
  vi.stubGlobal("window", { localStorage: { getItem: () => null } });
  const markup = renderToStaticMarkup(<I18nProvider locale="zh-TW"><MobilePresentationProvider mobile={mobile}><RemoteQuickConnect remote={remote} onConnected={vi.fn()} onCancel={vi.fn()} /></MobilePresentationProvider></I18nProvider>);
  for (const key of ["remote.quick.securityTitle", "remote.quick.securityBody", "remote.quick.deviceIdHint", "remote.connect.relayCodeHint", "remote.quick.relayHint"] as const) {
    expect(markup.includes(zhTW[key])).toBe(!mobile);
  }
  for (const key of ["remote.quick.title", "remote.quick.deviceId", "remote.connect.code", "remote.host.relayPlaceholder", "common.cancel"] as const) expect(markup).toContain(zhTW[key]);
  expect(markup.includes('aria-describedby="remote-quick-code-hint"')).toBe(!mobile);
});
it("retains mobile validation messages without rendering hints or sending credentials", async () => {
  const host = installHostDom(); Object.assign(window, { localStorage: { getItem: () => null } });
  const root = createRoot(host as unknown as Element);
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><MobilePresentationProvider mobile><RemoteQuickConnect remote={remote} onConnected={vi.fn()} onCancel={vi.fn()} /></MobilePresentationProvider></I18nProvider>));
    const id = allNodes(host).find(n => props(n)?.id === "remote-quick-id")!;
    expect(id).toBeDefined();
    await act(async () => props(id).onChange({ currentTarget: { value: "000 000 000" } }));
    const form = allNodes(host).find(n => n.tagName === "FORM")!;
    await act(async () => props(form).onSubmit({ preventDefault: vi.fn() }));
    expect(host.textContent).toContain(zhTW["remote.connect.relayCodeInvalid"]);
    expect(host.textContent).not.toContain(zhTW["remote.connect.relayCodeHint"]);
    expect(remote.connect).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});
