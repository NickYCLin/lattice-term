import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Workspace } from "../app/useWorkspace";
import { allNodes, installHostDom, props, type HostNode } from "../components/agents/testFixtures/interactionDom";
import { createConnectionProfile, emptyDraft, type ConnectionProfile } from "../domain/connection";
import { emptyDatabase } from "../domain/database";
import { I18nProvider } from "../i18n";
import { ConnectionsView } from "./ConnectionsView";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../components/overlays/modalFocus", () => ({ useModalFocus: () => {} }));
vi.mock("../components/files/FileDropZone", () => ({ FileDropZone: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

const host = { ...createConnectionProfile({ ...emptyDraft(), name: "測試主機", hostname: "db.invalid" }, "ssh-route"), machineId: "machine" };
const peer = { ...host, id: "rdp-route", protocol: "rdp" as const, port: 3389 };
let container: HostNode;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = installHostDom();
  root = createRoot(container as unknown as Element);
  invoke.mockResolvedValue({
    profiles: [
      { ...emptyDatabase("rdp-route"), name: "舊連線資料庫" },
      { ...emptyDatabase("machine"), name: "主機資料庫" },
      { ...emptyDatabase("other"), name: "其他主機資料庫" },
    ], revision: "original", credentialCleanupPending: 0,
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function render(profiles: ConnectionProfile[]) {
  const workspace = {
    profiles, visibleGroups: profiles.length ? [{ name: "", profiles }] : [],
    visibleProfiles: profiles, filterActive: false, sortOrder: "name", selectedId: null,
    setSortOrder: vi.fn(), resetFilter: vi.fn(), setSelectedId: vi.fn(),
    duplicateProfile: vi.fn(), toggleFavorite: vi.fn(), loadSamples: vi.fn(), importProfiles: vi.fn(),
  } as unknown as Workspace;
  await act(async () => root.render(<I18nProvider locale="zh-TW">
    <ConnectionsView workspace={workspace} onCreate={vi.fn()} onEdit={vi.fn()}
      onDelete={vi.fn()} onConnect={vi.fn()} supportedProtocols={["ssh", "rdp"]}
      backendAvailable mobile={false} />
  </I18nProvider>));
}

async function click(label: string) {
  const button = allNodes(container).find(node => node.tagName === "BUTTON" && node.textContent === label);
  expect(button, label).toBeDefined();
  await act(async () => props(button!).onClick());
}

it.each([{ profiles: [] }, { profiles: [host] }])("opens the database input form without requiring a host: %j", async ({ profiles }) => {
  await render(profiles);
  expect(invoke).not.toHaveBeenCalled();
  await click("新增／管理資料庫");
  expect(container.textContent).toContain("新增資料庫");
  expect(container.textContent).toContain("主機名稱／IP");
  expect(container.textContent).toContain("其他主機資料庫");
  expect(invoke).toHaveBeenCalledExactlyOnceWith("database_profiles");
});

it("opens a merged card with its host prefilled and both route identities in scope", async () => {
  await render([host, peer]);
  await click("資料庫設定");
  expect(container.textContent).toContain("舊連線資料庫");
  expect(container.textContent).toContain("主機資料庫");
  expect(container.textContent).not.toContain("其他主機資料庫");
  expect(allNodes(container).some(node => node.tagName === "INPUT" && props(node).value === "db.invalid")).toBe(true);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("database_profiles");
});
