import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { createConnectionProfile, emptyDraft } from "../../domain/connection";
import { allNodes, installHostDom, props } from "../agents/testFixtures/interactionDom";
import { ConnectionDrawer } from "./ConnectionDrawer";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("../../app/nativeRuntime", () => ({ hasDesktopBackend: () => true }));
vi.mock("./modalFocus", () => ({ useModalFocus: () => {} }));
afterEach(() => { native.invoke.mockReset(); vi.unstubAllGlobals(); });

it.each(["typed", "typed-failed", "cleared", "endpoint", "failed", "unchanged"])("keeps password visibility tied to the reveal request: %s", async (scenario) => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  const profile = createConnectionProfile({ ...emptyDraft(), name: "測試連線", hostname: "fixture.invalid", username: "tester" }, "credential-fixture");
  let finish!: (value: string) => void;
  let fail!: (reason: Error) => void;
  native.invoke.mockImplementation((command) => {
    if (command === "connection_credential_status") return Promise.resolve({ saved: true, allowMcpRead: false });
    if (command === "connection_credential_read") return new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
    throw new Error(`unexpected command ${command}`);
  });
  const secret = () => allNodes(container).find((node) => props(node)?.autoComplete === "new-password")!;
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><ConnectionDrawer profile={profile} profiles={[profile]} supportedProtocols={["ssh"]} mobile={false} onSave={vi.fn()} onClose={vi.fn()} /></I18nProvider>));
    const show = allNodes(container).find((node) => node.tagName === "BUTTON" && node.textContent === "顯示密碼")!;
    expect(show).toBeDefined();
    await act(async () => { props(show).onClick(); });
    expect(native.invoke).toHaveBeenLastCalledWith("connection_credential_read", { profileId: profile.id });
    if (scenario === "typed" || scenario === "typed-failed" || scenario === "cleared") {
      await act(async () => props(secret()).onChange({ currentTarget: { value: "replacement-fixture" } }));
      if (scenario === "cleared") await act(async () => props(secret()).onChange({ currentTarget: { value: "" } }));
    }
    if (scenario === "endpoint") {
      const hostname = allNodes(container).find((node) => props(node)?.["data-field"] === "hostname")!;
      await act(async () => props(hostname).onChange({ target: { value: "other.invalid" }, currentTarget: { value: "other.invalid" } }));
    }
    await act(async () => {
      if (scenario === "failed" || scenario === "typed-failed") fail(new Error("fixture read failure"));
      else finish("saved-fixture");
    });
    expect(props(secret()).type).toBe(scenario === "unchanged" ? "text" : "password");
    expect(props(secret()).value).toBe(scenario === "unchanged" ? "saved-fixture" : scenario.startsWith("typed") ? "replacement-fixture" : "");
    if (scenario === "typed-failed") expect(container.textContent).not.toContain("fixture read failure");
    if (scenario === "failed") expect(container.textContent).toContain("fixture read failure");
    if (scenario === "unchanged") {
      const hide = allNodes(container).find((node) => node.tagName === "BUTTON" && node.textContent === "隱藏密碼")!;
      await act(async () => { props(hide).onClick(); });
      expect(props(secret()).type).toBe("password");
    }
  } finally { await act(async () => root.unmount()); }
});
