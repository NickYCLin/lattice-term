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
vi.mock("../../app/useConnectionCredentialDraft", () => ({ useConnectionCredentialDraft: () => ({
  native: false, dirty: false, loading: false, secret: "", saved: false, allowMcpRead: false,
  setSecret() {}, setAllowMcpRead() {}, reveal() {}, invalidateReveal() {},
}) }));

const host = { ...createConnectionProfile({ ...emptyDraft(), name: "測試主機", hostname: "db.invalid", username: "reader" }, "ssh-route"), machineId: "machine" };
const peer = { ...host, id: "rdp-route", protocol: "rdp" as const, port: 3389 };
const database = { ...emptyDatabase("machine", "db.invalid"), name: "主機資料庫" };
const snapshot = { profiles: [database, { ...emptyDatabase("rdp-route"), name: "舊路徑資料庫" }, { ...emptyDatabase("other"), name: "其他主機資料庫" }], revision: "original", credentialCleanupPending: 0 };
let container: HostNode;
let root: ReturnType<typeof createRoot>;
const onClose = vi.fn();
const onSave = vi.fn();

beforeEach(() => {
  container = installHostDom();
  root = createRoot(container as unknown as Element);
  invoke.mockResolvedValue(snapshot);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function render(options: { newHost?: boolean; mobile?: boolean; available?: boolean; legacyHost?: boolean } = {}) {
  const selectedHost = options.legacyHost ? { ...host, machineId: undefined } : host;
  const linkedPeer = options.legacyHost ? { ...peer, machineId: host.id } : peer;
  await act(async () => root.render(<I18nProvider locale="zh-TW"><ConnectionDrawer
    profile={options.newHost ? null : selectedHost} profiles={[selectedHost, linkedPeer]} supportedProtocols={["ssh", "rdp"]}
    mobile={options.mobile ?? false} databaseAvailable={options.available ?? true} onSave={onSave} onClose={onClose}
  /></I18nProvider>));
}
function button(text: string) {
  const found = allNodes(container).find((node) => node.tagName === "BUTTON" && node.textContent === text);
  expect(found, text).toBeDefined();
  return found!;
}
async function click(text: string) {
  const target = button(text);
  expect(props(target).disabled).not.toBe(true);
  await act(async () => props(target).onClick());
}
async function editDatabase() {
  await click("主機資料庫 · PostgreSQL 5432");
  const input = allNodes(container).find((node) => props(node)?.value === "主機資料庫")!;
  await act(async () => props(input).onChange({ target: { value: "已修改資料庫" } }));
}
async function submitDatabase() {
  const form = allNodes(container).find((node) => node.tagName === "FORM" && !props(node).id)!;
  await act(async () => props(form).onSubmit({ preventDefault() {} }));
}

it("embeds the host databases below remote fields without a second dialog or nested form", async () => {
  await render();
  expect(allNodes(container).filter((node) => props(node)?.role === "dialog")).toHaveLength(1);
  const forms = allNodes(container).filter((node) => node.tagName === "FORM");
  expect(forms).toHaveLength(2);
  expect(allNodes(forms[0]).includes(forms[1])).toBe(false);
  expect(container.textContent).toContain("舊路徑資料庫");
  expect(container.textContent).not.toContain("其他主機資料庫");
  const hostname = allNodes(forms[1]).find((node) => props(node)?.maxLength === 253)!;
  expect(props(hostname).value).toBe("db.invalid");
  const nodes = allNodes(container);
  expect(nodes.indexOf(forms[1])).toBeGreaterThan(nodes.indexOf(forms[0]));
  await click("取消");
  expect(onClose).toHaveBeenCalledOnce();
});

it("includes legacy route databases when the primary host has no machine identity yet", async () => {
  await render({ legacyHost: true });
  expect(container.textContent).toContain("舊路徑資料庫");
  expect(container.textContent).not.toContain("其他主機資料庫");
});

it.each([{ mobile: true }, { available: false }, { newHost: true }])("does not load databases before a saved desktop host exists: %j", async (options) => {
  await render(options);
  expect(invoke).not.toHaveBeenCalled();
  if (options.newHost) expect(container.textContent).toContain("請先儲存遠端連線");
  else expect(container.textContent).not.toContain("資料庫連線");
});

it("asks before discarding database edits and prevents remote save from dropping them", async () => {
  await render(); await editDatabase();
  expect(props(button("儲存")).disabled).toBe(true);
  await act(async () => props(button("儲存並連線")).onClick());
  expect(onSave).not.toHaveBeenCalled();
  await click("取消");
  expect(onClose).not.toHaveBeenCalled();
  expect(container.textContent).toContain("要放棄這次的修改嗎？");
  await click("繼續編輯");
  expect(container.textContent).toContain("資料庫設定尚未儲存");
  await click("取消"); await click("放棄修改");
  expect(onClose).toHaveBeenCalledOnce();
});

it("keeps the drawer open during database save and unlocks remote saving afterwards", async () => {
  await render(); await editDatabase();
  let finish!: (value: typeof snapshot) => void;
  invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await submitDatabase();
  await click("取消");
  expect(onClose).not.toHaveBeenCalled();
  expect(props(button("儲存")).disabled).toBe(true);
  await act(async () => finish({ ...snapshot, profiles: [{ ...database, name: "已修改資料庫" }], revision: "updated" }));
  expect(props(button("儲存")).disabled).toBe(false);
  expect(onSave).not.toHaveBeenCalled();
  const remoteForm = allNodes(container).find((node) => node.tagName === "FORM" && props(node).id)!;
  await act(async () => props(remoteForm).onSubmit({ preventDefault() {} }));
  expect(onSave).toHaveBeenCalledOnce();
});

it("retains database edits and the discard guard after a save failure", async () => {
  await render(); await editDatabase();
  invoke.mockRejectedValueOnce(new Error("test save failure"));
  await submitDatabase();
  expect(container.textContent).toContain("test save failure");
  expect(props(button("儲存")).disabled).toBe(true);
  await click("取消");
  expect(onClose).not.toHaveBeenCalled();
  expect(container.textContent).toContain("要放棄這次的修改嗎？");
});
