import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { ConversationHandoffDialog } from "./ConversationHandoffDialog";
import { allNodes, installHostDom, props } from "./testFixtures/interactionDom";
import type { AgentDefinition } from "../../app/useAgentSessions";

vi.mock("../overlays/modalFocus", () => ({ useModalFocus: () => {} }));
afterEach(() => vi.unstubAllGlobals());
const definitions = [{ id: "codex", label: "Codex CLI", installed: true }, { id: "claude", label: "Claude Code", installed: true }] as AgentDefinition[];

it("allows manual summary after unreadable history, preserves edits on failure and guards double confirmation", async () => {
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  const confirm = vi.fn().mockRejectedValueOnce(new Error("Synthetic launch unavailable")).mockResolvedValue(undefined);
  const cancel = vi.fn();
  const load = vi.fn().mockRejectedValue(new Error("No readable history"));
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><ConversationHandoffDialog source="Synthetic old assistant"
      definitions={definitions} profiles={[]} loadSummary={load} onConfirm={confirm} onCancel={cancel} /></I18nProvider>));
    expect(host.textContent).toContain("自行填入");
    const textarea = allNodes(host).find(node => node.tagName === "TEXTAREA")!;
    await act(async () => props(textarea).onChange({ currentTarget: { value: "Synthetic goal and pending files" } }));
    const select = allNodes(host).find(node => node.tagName === "SELECT")!;
    await act(async () => props(select).onChange({ currentTarget: { value: "claude:::" } }));
    const submit = () => allNodes(host).find(node => node.tagName === "BUTTON" && node.textContent === "確認交接摘要")!;
    await act(async () => { props(submit()).onClick(); props(submit()).onClick(); });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]).toEqual(["Synthetic goal and pending files", expect.objectContaining({ definitionId: "claude" })]);
    expect(host.textContent).toContain("Synthetic launch unavailable");
    expect(props(textarea).value).toBe("Synthetic goal and pending files");
    await act(async () => props(submit()).onClick());
    expect(confirm).toHaveBeenCalledTimes(2);
    await act(async () => props(allNodes(host).find(node => node.tagName === "BUTTON" && node.textContent === "取消")!).onClick());
    expect(cancel).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); }
});

it("shows redacted edits before transmitting anything", async () => {
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  const confirm = vi.fn().mockResolvedValue(undefined);
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><ConversationHandoffDialog source="Fixture"
      definitions={definitions} profiles={[]} loadSummary={async () => "Goal"} onConfirm={confirm} onCancel={() => {}} /></I18nProvider>));
    const textarea = allNodes(host).find(node => node.tagName === "TEXTAREA")!;
    await act(async () => props(textarea).onChange({ currentTarget: { value: "password=synthetic-secret Goal" } }));
    const submit = () => allNodes(host).find(node => node.tagName === "BUTTON" && node.textContent === "確認交接摘要")!;
    await act(async () => props(submit()).onClick());
    expect(confirm).not.toHaveBeenCalled();
    expect(props(textarea).value).toBe("password=[redacted] Goal");
    await act(async () => props(submit()).onClick());
    expect(confirm.mock.calls[0][0]).toBe(props(textarea).value);
  } finally { await act(async () => root.unmount()); }
});

it("requires an explicit API model and keeps the selected endpoint identity", async () => {
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  const confirm = vi.fn().mockResolvedValue(undefined);
  const target = { definitionId: "codex", accountProfileId: null, model: "", provider: "cliproxyapi" as const, proxyId: "synthetic-endpoint" };
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><ConversationHandoffDialog source="Fixture"
      definitions={definitions} profiles={[]} initialTarget={target} apiTargets={[{ ...target, label: "Custom endpoint" }]}
      loadSummary={async () => "Synthetic summary"} onConfirm={confirm} onCancel={() => {}} /></I18nProvider>));
    const submit = () => allNodes(host).find(node => node.tagName === "BUTTON" && node.textContent === "確認交接摘要")!;
    expect(props(submit()).disabled).toBe(true);
    await act(async () => props(submit()).onClick());
    expect(confirm).not.toHaveBeenCalled();
    const input = allNodes(host).find(node => node.tagName === "INPUT")!;
    await act(async () => props(input).onChange({ currentTarget: { value: "synthetic-model" } }));
    await act(async () => props(submit()).onClick());
    expect(confirm.mock.calls[0][1]).toMatchObject({ model: "synthetic-model", proxyId: "synthetic-endpoint" });
  } finally { await act(async () => root.unmount()); }
});
