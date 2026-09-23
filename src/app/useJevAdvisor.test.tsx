import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { useJevAdvisor } from "./useJevAdvisor";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

it("requires opt-in and reviewed content; ignores results after switching or disabling", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let api!: ReturnType<typeof useJevAdvisor>;
  function Probe() { api = useJevAdvisor(); return null; }
  let finish!: (value: unknown) => void;
  invoke.mockImplementation((command: string) => {
    if (command === "jev_enabled") return Promise.resolve(false);
    if (command === "jev_configure") return Promise.resolve();
    if (command === "jev_preview") return Promise.resolve({ base64: btoa("Authentication expired") });
    if (command === "jev_analyze") return new Promise(resolve => { finish = resolve; });
    throw new Error("Unexpected IPC");
  });
  const result = { category: "login_required", confidence: 0.99, evidence: "Authentication expired", model: "jev-1.13.0", inputTokens: 300 };
  const analyzed = () => invoke.mock.calls.filter(([name]) => name === "jev_analyze");
  try {
    await act(async () => { root.render(<Probe />); });
    expect(invoke.mock.calls).toEqual([["jev_enabled"]]);
    await act(async () => { await api.analyze(); });
    expect(analyzed()).toHaveLength(0);
    await act(async () => { await api.configure("synthetic-test-key"); });
    await act(async () => { api.select("session-a"); });
    await act(async () => { await api.preview(); });
    expect(api.text).toBe("Authentication expired");
    await act(async () => { await api.analyze(); });
    expect(analyzed()).toHaveLength(0);
    await act(async () => { api.setConsent(true); });
    await act(async () => { void api.analyze(); void api.analyze(); });
    expect(analyzed()).toHaveLength(1);
    expect(analyzed()[0][1]).toEqual({ text: "Authentication expired", consent: true });
    await act(async () => { api.select("session-b"); finish(result); });
    expect(api.result).toBeNull();
    expect(api.consent).toBe(false);
    await act(async () => { api.edit("Another explicit login failure"); });
    await act(async () => { api.setConsent(true); });
    await act(async () => { void api.analyze(); });
    await act(async () => { await api.configure(null); finish(result); });
    expect(api.enabled).toBe(false);
    expect(api.text).toBe("");
    expect(api.result).toBeNull();
  } finally {
    await act(async () => { root.unmount(); });
    vi.clearAllMocks();
  }
});
