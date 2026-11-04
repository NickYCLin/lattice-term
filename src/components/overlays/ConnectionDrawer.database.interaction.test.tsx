import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { allNodes, installHostDom, props, type HostNode } from "../agents/testFixtures/interactionDom";
import { createConnectionProfile, emptyDraft } from "../../domain/connection";
import { emptyDatabase } from "../../domain/database";
import { I18nProvider } from "../../i18n";
import { ConnectionDrawer } from "./ConnectionDrawer";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./modalFocus", () => ({ useModalFocus: () => {} }));
vi.mock("../connections/SqlWorkbench", () => ({ SqlWorkbench: () => null }));
vi.mock("../../app/useConnectionCredentialDraft", () => ({ useConnectionCredentialDraft: () => ({
  native: false, dirty: false, loading: false, secret: "", saved: false, allowMcpRead: false,
  setSecret() {}, setAllowMcpRead() {}, reveal() {}, invalidateReveal() {},
}) }));

const host = { ...createConnectionProfile({ ...emptyDraft(), name: "測試主機", hostname: "remote.invalid", username: "operator" }, "ssh-route"), machineId: "machine" };
const database = { ...emptyDatabase("machine", "database.invalid"), id: "database", name: "訂單資料庫", database: "orders", username: "reader" };
const snapshot = { profiles: [database, { ...database, id: "other", hostKey: "other", name: "其他資料庫" }], revision: "original", credentialCleanupPending: 0 };
let container: HostNode;
let root: ReturnType<typeof createRoot>;
const onClose = vi.fn(), onSave = vi.fn(), onEditDatabase = vi.fn(), onOpenDatabase = vi.fn();

beforeEach(() => {
  container = installHostDom(); root = createRoot(container as unknown as Element);
  invoke.mockImplementation(async (command, args) => {
    if (command === "database_profiles") return snapshot;
    if (command === "database_save") return { ...snapshot, profiles: [args.profile], revision: "saved" };
    if (command === "database_test") return { columns: ["version"], rows: [["fixture"]] };
    throw Error(command);
  });
});
afterEach(async () => { await act(async () => root.unmount()); vi.clearAllMocks(); vi.unstubAllGlobals(); });

async function render(options: { database?: boolean; editing?: boolean; mobile?: boolean; available?: boolean } = {}) {
  await act(async () => root.render(<I18nProvider locale="zh-TW"><ConnectionDrawer
    profile={options.editing && !options.database ? host : null} profiles={[host]} supportedProtocols={["ssh", "rdp"]}
    mobile={options.mobile ?? false} databaseAvailable={options.available ?? true}
    initialMode={options.database ? "database" : "remote"} databaseProfileId={options.editing && options.database ? database.id : undefined}
    onEditDatabase={onEditDatabase} onOpenDatabase={onOpenDatabase} onSave={onSave} onClose={onClose}
  /></I18nProvider>));
}
function button(text: string) { const node = allNodes(container).find(node => node.tagName === "BUTTON" && node.textContent === text); expect(node, text).toBeDefined(); return node!; }
async function click(text: string) { const node = button(text); expect(props(node)?.disabled).not.toBe(true); await act(async () => props(node)?.onClick()); }
function databaseForm() { return allNodes(container).find(node => node.tagName === "FORM" && String(props(node)?.id).endsWith("-database"))!; }
async function submit(intent = "save") { await act(async () => props(databaseForm()).onSubmit({ preventDefault() {}, nativeEvent: { submitter: { getAttribute: () => intent } } })); }
async function change(predicate: (node: HostNode) => boolean, value: string) {
  const node = allNodes(databaseForm()).find(predicate)!; expect(node).toBeDefined();
  await act(async () => props(node)?.onChange({ target: { value }, currentTarget: { value } }));
}
async function fill() {
  await change(node => props(node)?.maxLength === 100, "獨立資料庫");
  await change(node => props(node)?.maxLength === 253, "database.invalid");
  await change(node => props(node)?.maxLength === 128 && props(node)?.autoComplete !== "off", "orders");
  await change(node => props(node)?.autoComplete === "off", "reader");
  await change(node => props(node)?.autoComplete === "new-password", "fixture-only-password");
}

it.each([false, true])("creates an independent database without a remote record or owner field (mobile=%s)", async mobile => {
  await render({ database: true, mobile }); await fill();
  expect(container.textContent).not.toContain("所屬主機");
  expect(container.textContent).not.toContain("兩者都用");
  expect(allNodes(container).filter(node => props(node)?.role === "dialog")).toHaveLength(1);
  expect(allNodes(container).filter(node => node.tagName === "BUTTON" && node.textContent === "儲存連線")).toHaveLength(1);
  await submit();
  expect(invoke).toHaveBeenCalledWith("database_save", expect.objectContaining({ profile: expect.objectContaining({ name: "獨立資料庫", hostKey: "local" }), password: "fixture-only-password" }));
  expect(onSave).not.toHaveBeenCalled(); expect(onClose).toHaveBeenCalledOnce();
});

it("tests a draft without saving it or closing the editor", async () => {
  await render({ database: true }); await fill(); await submit("test");
  expect(invoke).toHaveBeenCalledWith("database_test", expect.objectContaining({ profile: expect.objectContaining({ hostKey: "local", name: "獨立資料庫" }), revision: "original" }));
  expect(invoke.mock.calls.some(([command]) => command === "database_save")).toBe(false);
  expect(onClose).not.toHaveBeenCalled(); expect(container.textContent).toContain("連線測試成功");
});

it("saves the exact selected database before opening SQL", async () => {
  await render({ database: true, editing: true }); await submit("open");
  expect(invoke).toHaveBeenCalledWith("database_save", expect.objectContaining({ profile: database, password: null }));
  expect(onOpenDatabase).toHaveBeenCalledExactlyOnceWith(database.id);
  expect(onSave).not.toHaveBeenCalled();
});

it.each(["save", "test"])("keeps edits after a %s failure and guards against discarding them", async intent => {
  await render({ database: true }); await fill(); invoke.mockRejectedValueOnce(Error("fixture failure")); await submit(intent);
  expect(container.textContent).toContain("fixture failure"); expect(onClose).not.toHaveBeenCalled();
  await click("取消"); expect(onClose).not.toHaveBeenCalled(); expect(container.textContent).toContain("要放棄這次的修改嗎？");
  await click("繼續編輯"); expect(allNodes(databaseForm()).some(node => props(node)?.value === "獨立資料庫")).toBe(true);
});

it("shows related database links without embedding another editor or mixing saves", async () => {
  await render({ editing: true });
  expect(allNodes(container).filter(node => node.tagName === "FORM")).toHaveLength(1);
  expect(container.textContent).toContain("訂單資料庫"); expect(container.textContent).not.toContain("其他資料庫");
  await click("連線設定"); expect(onEditDatabase).toHaveBeenCalledExactlyOnceWith(database.id);
  expect(invoke.mock.calls.some(([command]) => command === "database_read")).toBe(false);
});

it("opens related SQL without connecting to the remote host", async () => {
  await render({ editing: true }); await click("開啟 SQL");
  expect(onOpenDatabase).toHaveBeenCalledExactlyOnceWith(database.id); expect(onSave).not.toHaveBeenCalled();
});

it("protects unsaved remote edits before navigating to a database", async () => {
  await render({ editing: true });
  const input = allNodes(container).find(node => node.tagName === "INPUT" && props(node)?.value === host.name)!;
  await act(async () => props(input).onChange({ target: { value: "未儲存遠端" }, currentTarget: { value: "未儲存遠端" } }));
  await click("連線設定"); expect(onEditDatabase).not.toHaveBeenCalled();
  await click("放棄修改"); expect(onEditDatabase).toHaveBeenCalledExactlyOnceWith(database.id);
});

it("does not load database metadata in browser-only mode", async () => {
  await render({ editing: true, available: false }); expect(invoke).not.toHaveBeenCalled();
});

it("confirms a purpose switch and clears the previous remote draft", async () => {
  await render();
  const input = allNodes(container).find(node => node.tagName === "INPUT" && String(props(node)?.id).endsWith("-name"))!;
  await act(async () => props(input).onChange({ currentTarget: { value: "未儲存主機" } }));
  const databaseRadio = allNodes(container).find(node => props(node)?.["aria-label"] === "資料庫連線")!;
  await act(async () => props(databaseRadio).onChange());
  expect(container.textContent).toContain("要放棄這次的修改嗎？");
  await click("放棄修改");
  expect(container.textContent).not.toContain("要放棄這次的修改嗎？");
  expect(databaseForm()).toBeDefined();
  await click("取消");
  expect(onClose).toHaveBeenCalledOnce();
});
