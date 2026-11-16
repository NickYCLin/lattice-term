import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { allNodes, installHostDom, props, type HostNode } from "../components/agents/testFixtures/interactionDom";
import type { Workspace } from "../app/useWorkspace";
import { createConnectionProfile, emptyDraft, type ConnectionProfile } from "../domain/connection";
import type { ConnectionImportPlan } from "../domain/export";
import { I18nProvider } from "../i18n";
import { ConnectionsView } from "./ConnectionsView";
const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../app/localFiles", async original => ({ ...await original<typeof import("../app/localFiles")>(), readSelectedText: read }));
vi.mock("../components/overlays/modalFocus", () => ({ useModalFocus: () => {} }));
vi.mock("../app/useDatabaseCatalog", () => ({ useDatabaseCatalog: () => ({ profiles: [], loading: false, error: null, refresh: vi.fn() }) }));
vi.mock("../components/files/FileDropZone", () => ({ FileDropZone: ({ children, onSelect }: { children: ReactNode; onSelect: (file: File) => void }) =>
  <div data-import-drop onDrop={() => onSelect({ name: "fixture.json", size: 0 } as File)}>{children}</div> }));
const existing = createConnectionProfile({ ...emptyDraft("ssh"), name: "Existing", hostname: "fixture.invalid", username: "reader" }, "local");
let host: HostNode, root: ReturnType<typeof createRoot>;
const save = vi.fn(async (plan: ConnectionImportPlan) => ({ count: plan.changes.length, addedCount: plan.addedCount, overwrittenCount: plan.overwrittenCount, error: null as string | null }));
beforeEach(() => { host = installHostDom(); root = createRoot(host as unknown as Element); save.mockClear(); read.mockReset(); });
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
async function render(profiles: ConnectionProfile[] = [existing], locale: "zh-TW" | "en" | "zh-CN" = "zh-TW") {
  const workspace = { profiles, visibleGroups: profiles.length ? [{ name: "", profiles }] : [], visibleProfiles: profiles,
    filterActive: false, sortOrder: "name", selectedId: null, setSortOrder: vi.fn(), resetFilter: vi.fn(), setSelectedId: vi.fn(),
    duplicateProfile: vi.fn(), toggleFavorite: vi.fn(), loadSamples: vi.fn(), importProfiles: save,
  } as unknown as Workspace;
  await act(async () => root.render(<I18nProvider locale={locale}><ConnectionsView workspace={workspace} onCreate={vi.fn()} onEdit={vi.fn()}
    onDelete={vi.fn()} onConnect={vi.fn()} supportedProtocols={["ssh"]} backendAvailable={false} mobile={false} /></I18nProvider>));
}
async function selectFile() {
  const input = allNodes(host).find(node => node.tagName === "INPUT" && props(node).type === "file")!;
  await act(async () => props(input).onChange({ target: { files: [{ name: "fixture.json", size: 0 }], value: "fixture.json" } }));
}
async function click(text: string) {
  const button = allNodes(host).find(node => node.tagName === "BUTTON" && node.textContent === text)!;
  expect(button).toBeDefined(); await act(async () => props(button).onClick());
}

it("previews unique add/overwrite counts and cancelling never calls persistence", async () => {
  read.mockResolvedValue(JSON.stringify([{ ...existing, name: "First" }, { ...existing, name: "Last" }, { ...existing, id: undefined, username: "other", name: "New" }]));
  await render(); await selectFile();
  expect(host.textContent).toContain("新增 1 筆／覆蓋 1 筆");
  expect(host.textContent).toContain("Last"); expect(host.textContent).toContain("New");
  expect(save).not.toHaveBeenCalled();
  await click("取消"); expect(save).not.toHaveBeenCalled();
  expect(allNodes(host).some(node => props(node)?.role === "alertdialog")).toBe(false);
});

it("saves only after confirmation and reports additions separately from overwrites", async () => {
  read.mockResolvedValue(JSON.stringify([{ ...existing, name: "Renamed" }]));
  await render(); await selectFile(); await click("確認匯入");
  expect(save).toHaveBeenCalledTimes(1);
  expect(save.mock.calls[0][0].next[0]).toMatchObject({ id: existing.id, name: "Renamed" });
  expect(host.textContent).toContain("新增 0 筆／覆蓋 1 筆連線設定");
  expect(allNodes(host).some(node => props(node)?.role === "alertdialog")).toBe(false);
});

it("uses the same confirmation preview for empty-state drag and drop", async () => {
  read.mockResolvedValue(JSON.stringify([{ ...existing, id: undefined }]));
  await render([]);
  const drop = allNodes(host).find(node => props(node)?.["data-import-drop"] !== undefined)!;
  await act(async () => props(drop).onDrop());
  expect(host.textContent).toContain("新增 1 筆／覆蓋 0 筆");
  expect(save).not.toHaveBeenCalled(); await click("取消"); expect(save).not.toHaveBeenCalled();
});

it("does not auto-confirm a preview when the file contained invalid entries", async () => {
  read.mockResolvedValue(JSON.stringify([{ ...existing }, { name: "", hostname: "" }]));
  await render(); await selectFile(); expect(save).not.toHaveBeenCalled();
  expect(host.textContent).toContain("新增 0 筆／覆蓋 1 筆");
  await click("確認匯入");
  expect(host.textContent).toContain("匯入完成，但有部分略過");
  expect(host.textContent).toContain("新增 0 筆／覆蓋 1 筆連線設定");
});

it("shows fallback-language add/overwrite numbers without leaving an old count placeholder", async () => {
  read.mockResolvedValue(JSON.stringify([{ ...existing }]));
  await render([existing], "zh-CN"); await selectFile(); await click("Confirm import");
  expect(host.textContent).toContain("0 connections added / 1 overwritten");
  expect(host.textContent).not.toContain("{count}");
});

it("blocks confirmation when ID priority would create a duplicate local endpoint", async () => {
  const second = { ...existing, id: "second", name: "Second", hostname: "second.invalid" };
  read.mockResolvedValue(JSON.stringify([{ ...existing, hostname: second.hostname }]));
  await render([existing, second]); await selectFile();
  expect(host.textContent).toContain("不同本機項目的端點重複");
  const confirm = allNodes(host).find(node => node.tagName === "BUTTON" && node.textContent === "確認匯入")!;
  expect(props(confirm).disabled).toBe(true);
  await act(async () => props(confirm).onClick()); expect(save).not.toHaveBeenCalled();
});

it("hides route changes for old exports and requires confirmation to apply explicit route changes", async () => {
  const gateway = { ...existing, id: "gateway", hostname: "192.0.2.20", name: "Synthetic Gateway" };
  const other = { ...gateway, id: "other", hostname: "192.0.2.21", name: "Synthetic Other Gateway" };
  const local = { ...existing, jumpProfileId: gateway.id };
  read.mockResolvedValue(JSON.stringify([existing])); await render([local, gateway, other]); await selectFile();
  expect(host.textContent).not.toContain("路線變更"); await click("取消"); expect(save).not.toHaveBeenCalled();
  read.mockResolvedValue(JSON.stringify([{ ...existing, jumpProfileId: other.id }])); await selectFile();
  expect(host.textContent).toContain("路線變更"); expect(host.textContent).toContain("更換跳板");
  expect(host.textContent).toContain("Synthetic Gateway → Synthetic Other Gateway"); expect(save).not.toHaveBeenCalled();
  await click("確認匯入"); expect(save.mock.calls[0][0].next[0].jumpProfileId).toBe(other.id);
});
it("lists unresolved references in the preview and does not write when cancelled", async () => {
  read.mockResolvedValue(JSON.stringify([{ ...existing, jumpProfileId: "missing-gateway", retiredTo: "missing-target" }]));
  await render(); await selectFile(); expect(host.textContent).toContain("無法對應的路線參照將清除");
  expect(host.textContent).toContain("Existing"); expect(host.textContent).toContain("missing-gateway"); expect(host.textContent).toContain("還原舊卡到列表");
  expect(save).not.toHaveBeenCalled(); await click("取消"); expect(save).not.toHaveBeenCalled();
});
