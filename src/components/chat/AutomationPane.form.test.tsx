import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { allNodes, installHostDom, props } from "../agents/testFixtures/interactionDom";
import { createAutomation, emptyAutomationDraft } from "../../app/agentAutomations";
import { fakeAgentApi, fakeAutomationsApi, fakeChatApi, fakeDefinition, installFakeStorage } from "../../app/testFixtures/agentApis";
import { I18nProvider } from "../../i18n";
import { ChatView } from "../../views/ChatView";
import { AutomationPane } from "./AutomationPane";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => "/synthetic/project") }));
vi.mock("../files/PathDropZone", () => ({ PathDropZone: ({ children }: { children: React.ReactNode }) => children }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([false, true])("keeps schedule visible beside save and validates the required folder (editing=%s)", async editingExisting => {
  const cleanup = installFakeStorage();
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  const initial = emptyAutomationDraft({ name: "合成巡檢", instructions: "檢查合成資料", workingDirectory: "" });
  const automation = createAutomation(initial, "synthetic");
  const api = fakeAutomationsApi({ automations: editingExisting ? [automation] : [], create: vi.fn(() => automation) });
  const submit = () => props(allNodes(host).find(node => node.tagName === "FORM")!).onSubmit({ preventDefault() {} });
  const summary = () => allNodes(host).find(node => props(node)?.className === "automation-form__schedule-summary")!;
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><AutomationPane automations={api}
      selectedId={editingExisting ? automation.id : null} editing={!editingExisting} defaults={initial}
      installed={["codex"]} cliLabel={() => "Codex"} models={fakeChatApi().models} loadModels={() => {}}
      onSelect={() => {}} onDoneEditing={() => {}} onOpenThread={() => {}} /></I18nProvider>));
    if (editingExisting) await act(async () => props(allNodes(host).find(node => node.tagName === "BUTTON" && node.textContent === "編輯")!).onClick());
    expect(host.textContent).toContain("專案資料夾（必填）");
    expect(host.textContent).not.toContain("專案資料夾（選填）");
    expect(summary().textContent).toContain("09:00");
    expect(summary().textContent).toContain("平日");
    const nodes = allNodes(host);
    expect(nodes.indexOf(nodes.find(node => node.tagName === "FIELDSET")!)).toBeLessThan(nodes.indexOf(nodes.find(node => node.tagName === "TEXTAREA")!));
    expect(props(summary().parentNode!).className).toBe("chat-composer__box");
    const time = nodes.find(node => props(node)?.type === "time")!;
    await act(async () => props(time).onChange({ target: { value: "14:30" } }));
    expect(summary().textContent).toContain("14:30");
    expect(summary().textContent).not.toContain("09:00");
    await act(async () => submit());
    expect(host.textContent).toContain("請選擇工作目錄");
    expect(api.create).not.toHaveBeenCalled();
    expect(api.update).not.toHaveBeenCalled();
    await act(async () => props(allNodes(host).find(node => node.tagName === "BUTTON" && node.textContent === "選擇工作目錄")!).onClick());
    await act(async () => submit());
    const saved = editingExisting ? vi.mocked(api.update).mock.calls[0][1] : vi.mocked(api.create).mock.calls[0][0];
    expect(saved.schedule).toEqual({ kind: "daily", time: "14:30", weekdays: [1, 2, 3, 4, 5] });
    expect(saved.workingDirectory).toBe("/synthetic/project");
  } finally { await act(async () => root.unmount()); cleanup(); }
});

it("keeps new drafts separate from the automatically selected schedule and follows selection changes", async () => {
  const cleanup = installFakeStorage();
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  const first = createAutomation(emptyAutomationDraft({ name: "第一份合成任務", instructions: "第一份指示", workingDirectory: "/synthetic" }), "first");
  const second = createAutomation(emptyAutomationDraft({ name: "第二份合成任務", instructions: "第二份指示", workingDirectory: "/synthetic" }), "second");
  const api = fakeAutomationsApi({ automations: [first, second] });
  const click = async (text: string) => act(async () => props(allNodes(host).find(node => node.tagName === "BUTTON" && (node.textContent.includes(text) || props(node)?.["aria-label"] === text))!).onClick());
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><ChatView mode="automations"
      agents={fakeAgentApi({ catalog: [fakeDefinition()] })} chat={fakeChatApi()} automations={api} onOpenSession={() => {}} /></I18nProvider>));
    expect(allNodes(host).find(node => node.tagName === "H2")!.textContent).toBe(first.name);
    await click(second.name);
    expect(allNodes(host).find(node => node.tagName === "H2")!.textContent).toBe(second.name);
    await click("編輯");
    expect(props(allNodes(host).find(node => node.tagName === "TEXTAREA")!).value).toBe(second.instructions);
    await click("新增排程");
    expect(props(allNodes(host).find(node => node.tagName === "TEXTAREA")!).value).toBe("");
    await click("取消");
    expect(allNodes(host).find(node => node.tagName === "H2")!.textContent).toBe(first.name);
    expect(api.create).not.toHaveBeenCalled();
    expect(api.update).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); cleanup(); }
});
