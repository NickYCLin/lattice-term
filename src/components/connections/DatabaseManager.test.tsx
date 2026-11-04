import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installFakeDom } from "../../app/testFixtures/hookDom";
import { createConnectionProfile, emptyDraft } from "../../domain/connection";
import { databaseEngines, type DatabaseProfile, type DatabaseSnapshot } from "../../domain/database";
import { DatabaseManager } from "./DatabaseManager";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../overlays/modalFocus", () => ({ useModalFocus: () => {} }));
vi.mock("./SqlWorkbench", () => ({ SqlWorkbench: () => <section aria-label="測試 SQL 工作台" /> }));

type Host = Record<string, unknown> & { childNodes?: Host[] };
type Props = {
  hidden?: boolean;
  rows?: number;
  autoComplete?: string;
  maxLength?: number;
  children?: unknown; value?: unknown; type?: string; checked?: boolean; disabled?: boolean;
  onClick?: () => void;
  onSubmit?: (event: { preventDefault: () => void }) => void;
  onChange?: (event: { target: { value?: string; checked?: boolean } }) => void;
};
function hostProps(node: Host): Props[] {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return [...(key ? [node[key] as Props] : []), ...(node.childNodes ?? []).flatMap(hostProps)];
}

const host = createConnectionProfile({ ...emptyDraft(), name: "測試主機", hostname: "db.invalid" }, "host");
const database: DatabaseProfile = {
  id: "first", hostKey: "host", name: "測試資料庫", engine: "postgres", hostname: "db.invalid",
  port: 5432, username: "reader", database: "sample", sqlitePath: "", allowMcpRead: false,
};
let container: ReturnType<typeof installFakeDom>;
let root: ReturnType<typeof createRoot>;
let snapshot: DatabaseSnapshot;

beforeEach(() => {
  container = installFakeDom();
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((...args) => Object.assign(createElement(...args), { options: [] }));
  root = createRoot(container as unknown as Element);
  snapshot = { profiles: [database, { ...database, id: "second", name: "另一個版本" }], revision: "original", credentialCleanupPending: 0 };
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "database_profiles") return snapshot;
    if (command === "database_save") {
      const savedProfile = args!.profile as DatabaseProfile;
      const exists = snapshot.profiles.some((profile) => profile.id === savedProfile.id);
      snapshot = { ...snapshot, profiles: exists ? snapshot.profiles.map((profile) => profile.id === savedProfile.id ? savedProfile : profile) : [...snapshot.profiles, savedProfile], revision: "updated" };
      return snapshot;
    }
    if (command === "database_delete") return { ...snapshot, profiles: snapshot.profiles.filter((profile) => profile.id !== args!.profileId) };
    if (command === "database_read") return { columns: ["schema", "table"], rows: [["public", "sample"]], truncated: false, cellCharacterLimit: 512, stableOrder: false };
    throw new Error(`unexpected command ${command}`);
  });
});
afterEach(async () => { await act(async () => root.unmount()); vi.restoreAllMocks(); vi.clearAllMocks(); });

async function render() {
  await act(async () => root.render(<DatabaseManager profiles={[host]} hostKeys={["host"]} onClose={() => {}} />));
}
async function click(label: string) {
  const props = hostProps(container).find((props) => props.onClick && (props.children === label || (Array.isArray(props.children) && props.children.includes(label))));
  expect(props, label).toBeDefined();
  expect(props!.disabled, label).not.toBe(true);
  await act(async () => props!.onClick!());
}
async function change(predicate: (props: Props) => boolean, target: { value?: string; checked?: boolean }) {
  const props = hostProps(container).find((props) => props.onChange && predicate(props));
  expect(props).toBeDefined();
  await act(async () => props!.onChange!({ target }));
}
async function submit() {
  await act(async () => hostProps(container).find((props) => props.onSubmit)!.onSubmit!({ preventDefault() {} }));
}

it.each(databaseEngines)("creates and reopens a $value connection without replacing another version", async (engine) => {
  await render();
  await click("測試資料庫");
  await click("新增資料庫連線");
  await change((props) => props.value === "postgres" && Array.isArray(props.children), { value: engine.value });
  await change((props) => props.maxLength === 100, { value: "新資料庫" });
  if (engine.value === "sqlite") {
    await change((props) => props.maxLength === 2048, { value: "C:/test/sample.sqlite" });
  } else {
    await change((props) => props.maxLength === 253, { value: "db.invalid" });
    await change((props) => props.maxLength === 128 && props.autoComplete !== "off", { value: "sample" });
    await change((props) => props.autoComplete === "off", { value: "reader" });
    await change((props) => props.type === "password", { value: "test-only-password" });
  }
  await submit();
  const savedProfile = snapshot.profiles.find((profile) => profile.name === "新資料庫")!;
  expect(savedProfile).toMatchObject({ hostKey: "local", engine: engine.value, port: engine.port, allowMcpRead: false });
  expect(savedProfile.id).not.toBe(database.id);
  expect(savedProfile).not.toHaveProperty("password");
  expect(snapshot.profiles).toHaveLength(3);
  expect(snapshot.profiles[0]).toEqual(database);
  expect(invoke).toHaveBeenCalledWith("database_save", { profile: savedProfile, revision: "original", password: engine.value === "sqlite" ? null : "test-only-password" });
  expect(hostProps(container).find((props) => props.children === "測試連線／讀取版本")!.disabled).toBe(false);
  await click("另一個版本");
  await click("新資料庫");
  expect(hostProps(container).some((props) => props.value === "新資料庫")).toBe(true);
  if (engine.value !== "sqlite") expect(hostProps(container).find((props) => props.type === "password")!.value).toBe("");
  await click("測試連線／讀取版本");
  expect(invoke).toHaveBeenLastCalledWith("database_read", { action: { kind: "version", profileId: savedProfile.id } });
});

it("does not carry a password or MCP grant across database engine changes", async () => {
  snapshot.profiles[0] = { ...database, allowMcpRead: true };
  await render(); await click("測試資料庫");
  await change((props) => props.type === "password", { value: "test-only-password" });
  await change((props) => props.value === "postgres" && Array.isArray(props.children), { value: "mysql" });
  expect(hostProps(container).find((props) => props.type === "password")!.value).toBe("");
  expect(hostProps(container).find((props) => props.type === "checkbox")!.checked).toBe(false);
  expect(hostProps(container).find((props) => props.type === "number")!.value).toBe(3306);
  await change((props) => props.value === "mysql" && Array.isArray(props.children), { value: "sqlite" });
  expect(hostProps(container).some((props) => props.type === "password")).toBe(false);
  await change((props) => props.value === "sqlite" && Array.isArray(props.children), { value: "postgres" });
  expect(hostProps(container).find((props) => props.type === "password")!.value).toBe("");
  expect(hostProps(container).find((props) => props.type === "checkbox")!.checked).toBe(false);
});

it.each(["save", "delete", "read"])("serializes same-turn database %s requests and unlocks after failure", async (operation) => {
  await render(); await click("測試資料庫");
  let run: () => void;
  if (operation === "save") {
    await change((props) => props.value === "測試資料庫", { value: "更新名稱" });
    const form = hostProps(container).find((props) => props.onSubmit)!;
    run = () => form.onSubmit!({ preventDefault() {} });
  } else {
    if (operation === "delete") await click("刪除此資料庫連線");
    const label = operation === "delete" ? "確認刪除此連線" : "測試連線／讀取版本";
    run = hostProps(container).find((props) => props.children === label)!.onClick!;
  }
  let rejectRequest!: (reason: Error) => void;
  invoke.mockImplementationOnce(() => new Promise((_, reject) => { rejectRequest = reject; }));
  const command = `database_${operation}`;
  await act(async () => { run(); run(); });
  expect(invoke.mock.calls.filter(([name]) => name === command)).toHaveLength(1);
  await act(async () => rejectRequest(new Error("temporary failure")));
  expect(hostProps(container).some((props) => props.children === "Error: temporary failure")).toBe(true);
  await act(async () => run());
  expect(invoke.mock.calls.filter(([name]) => name === command)).toHaveLength(2);
});

it("keeps metadata separate from passwords and saves explicit MCP permission", async () => {
  await render(); await click("測試資料庫");
  expect(hostProps(container).find((props) => props.type === "password")!.value).toBe("");
  await change((props) => props.type === "checkbox", { checked: true });
  await submit();
  expect(invoke).toHaveBeenCalledWith("database_save", { profile: { ...database, allowMcpRead: true }, revision: "original", password: null });
  expect(invoke).not.toHaveBeenCalledWith("database_read", expect.anything());
});

it("revokes the previous database grant when the endpoint changes", async () => {
  snapshot.profiles[0] = { ...database, allowMcpRead: true };
  await render(); await click("測試資料庫");
  await change((props) => props.value === "db.invalid", { value: "new.invalid" });
  expect(hostProps(container).find((props) => props.type === "checkbox")!.checked).toBe(false);
  const testButton = hostProps(container).find((props) => props.children === "測試連線／讀取版本")!;
  expect(testButton.disabled).toBe(true);
});

it("requires a specific delete confirmation and leaves the other version alone", async () => {
  await render(); await click("測試資料庫");
  await click("刪除此資料庫連線");
  expect(invoke).not.toHaveBeenCalledWith("database_delete", expect.anything());
  await click("確認刪除此連線");
  expect(invoke).toHaveBeenCalledWith("database_delete", { profileId: "first", revision: "original" });
  expect(hostProps(container).some((props) => Array.isArray(props.children) && props.children.includes("另一個版本"))).toBe(true);
});

it("revokes MCP when CA changes and accepts canonical saved profiles after clearing it", async () => {
  snapshot.profiles[0] = { ...database, tlsCaPem: "old CA", allowMcpRead: true };
  await render(); await click("測試資料庫");
  await change((props) => props.rows === 5, { value: "" });
  expect(hostProps(container).find((props) => props.type === "checkbox")!.checked).toBe(false);
  invoke.mockResolvedValueOnce({ ...snapshot, profiles: [database], revision: "saved" });
  await submit();
  expect(hostProps(container).find((props) => props.children === "測試連線／讀取版本")!.disabled).toBe(false);
  await click("測試連線／讀取版本");
});

it("uses structured read requests with saved identities and bounded pagination", async () => {
  await render(); await click("測試資料庫"); await click("測試連線／讀取版本");
  expect(invoke).toHaveBeenLastCalledWith("database_read", { action: { kind: "version", profileId: "first" } });
  await click("列出資料表");
  await change((props) => props.value === "" && props.type !== "password" && Array.isArray(props.children), { value: "0" });
  await click("讀取前 50 筆");
  expect(invoke).toHaveBeenLastCalledWith("database_read", { action: { kind: "rows", profileId: "first", schema: "public", table: "sample", limit: 50, offset: 0 } });
  invoke.mockResolvedValueOnce({ columns: ["value"], rows: [["one"], ["two"]], truncated: true, cellCharacterLimit: 512, stableOrder: false });
  await click("讀取前 50 筆");
  await click("下一頁");
  expect(invoke).toHaveBeenLastCalledWith("database_read", { action: { kind: "rows", profileId: "first", schema: "public", table: "sample", limit: 50, offset: 2 } });
  await click("上一頁");
  expect(invoke).toHaveBeenLastCalledWith("database_read", { action: { kind: "rows", profileId: "first", schema: "public", table: "sample", limit: 50, offset: 0 } });
});

it("shows load failures rather than silently pretending there are no saved connections", async () => {
  invoke.mockRejectedValueOnce("資料庫設定檔無法解析；原檔已保留，請先修復。");
  await render();
  expect(hostProps(container).some((props) => props.children === "資料庫設定檔無法解析；原檔已保留，請先修復。")).toBe(true);
  expect(hostProps(container).some((props) => props.disabled === true)).toBe(true);
});

it("opens the first saved connection in the SQL workspace and keeps settings in their own view", async () => {
  await render();
  expect(hostProps(container).find((props) => props.onSubmit)!.hidden).toBe(true);
  expect(hostProps(container).some((props) => props.value === database.name)).toBe(true);
  await click("連線設定");
  expect(hostProps(container).find((props) => props.onSubmit)!.hidden).toBe(false);
  await click("另一個版本");
  expect(hostProps(container).find((props) => props.onSubmit)!.hidden).toBe(true);
});

it("requires saving or cancelling edited settings before switching connections or closing", async () => {
  await render(); await click("連線設定");
  await change((props) => props.maxLength === 100, { value: "尚未儲存" });
  expect(hostProps(container).find((props) => Array.isArray(props.children) && props.children.includes("另一個版本"))!.disabled).toBe(true);
  expect(hostProps(container).find((props) => props.children === "關閉")!.disabled).toBe(true);
  await click("取消編輯");
  expect(hostProps(container).find((props) => props.children === "關閉")!.disabled).toBe(false);
  expect(hostProps(container).some((props) => props.value === database.name)).toBe(true);
});


it("lets the user reveal only a newly typed password without retrieving saved credentials", async () => {
  await render(); await click("連線設定");
  const password = () => hostProps(container).find(p => p.autoComplete === "new-password")!;
  expect(password().value).toBe(""); expect(password().type).toBe("password");
  await change(p => p.autoComplete === "new-password", {value:"test-only-password"});
  await click("顯示密碼");
  expect(password().type).toBe("text"); expect(password().value).toBe("test-only-password");
  await click("隱藏密碼"); expect(password().type).toBe("password");
  expect(invoke.mock.calls.some(([command]) => command === "database_save")).toBe(false);
  await click("顯示密碼"); await submit();
  expect(password().type).toBe("password"); expect(password().value).toBe("");
});


it("keeps connection editing in the shared setup without mounting a query workspace", async () => {
  const selected = vi.fn();
  await act(async () => root.render(<DatabaseManager profiles={[host]} settingsOnly initialProfileId="second" onProfileSelected={selected} onClose={() => {}} />));
  expect(selected).toHaveBeenCalledWith(snapshot.profiles[1]);
  expect(hostProps(container).find(p => p.onSubmit)!.hidden).toBe(false);
  expect(hostProps(container).some(p => p.children === "SQL 工作台")).toBe(false);
});

it("routes query settings to the shared connection editor", async () => {
  const configure = vi.fn();
  await act(async () => root.render(<DatabaseManager profiles={[host]} onConfigure={configure} onClose={() => {}} />));
  await click("連線設定");
  expect(configure).toHaveBeenCalledWith(database.id, database.hostKey);
  expect(hostProps(container).find(p => p.onSubmit)!.hidden).toBe(true);
});

it("defers catalog updates until local connection edits have been cancelled", async () => {
  const view = (revision: number) => <DatabaseManager profiles={[host]} settingsOnly catalogRevision={revision} onClose={() => {}} />;
  await act(async () => root.render(view(0)));
  await change(p => p.maxLength === 100, {value: "本機未儲存"});
  snapshot = {...snapshot, revision: "external", profiles: [{...database, name:"外部更新"}]};
  await act(async () => root.render(view(1)));
  expect(invoke.mock.calls.filter(([c]) => c === "database_profiles")).toHaveLength(1);
  expect(hostProps(container).some(p => p.value === "本機未儲存")).toBe(true);
  await click("取消編輯");
  expect(invoke.mock.calls.filter(([c]) => c === "database_profiles")).toHaveLength(2);
  expect(hostProps(container).some(p => p.value === "外部更新")).toBe(true);
});

it("preserves legacy associations when editing without exposing an owner requirement", async () => {
  snapshot.profiles = [{...database, hostname:"database.invalid"}];
  await act(async () => root.render(<DatabaseManager profiles={[host]} hostKeys={[host.id]} initialProfileId={database.id} settingsOnly onClose={() => {}} />));
  expect(hostProps(container).some(p => p.children === "所屬主機")).toBe(false);
  await change(p => p.maxLength === 100, {value:"調整顯示名稱"});
  expect(hostProps(container).some(p => p.value === "reader")).toBe(true);
  expect(hostProps(container).find(p => p.type === "password")!.value).toBe("");
  await submit();
  expect(snapshot.profiles[0]).toMatchObject({id:database.id, hostKey:database.hostKey, hostname:"database.invalid", username:"reader"});
});

it("groups or separates cards without changing the database endpoint, password, or MCP grant", async () => {
  snapshot.profiles = [{...database, hostKey:"local", allowMcpRead:true}];
  await act(async () => root.render(<DatabaseManager profiles={[host]} initialProfileId={database.id} settingsOnly onClose={() => {}} />));
  await change(p => p.value === "local" && Array.isArray(p.children), {value:host.id});
  await submit();
  expect(invoke).toHaveBeenCalledWith("database_save", {profile:{...database, hostKey:host.id, allowMcpRead:true},revision:"original",password:null});
  await change(p => p.value === host.id && Array.isArray(p.children), {value:"local"});
  await submit();
  expect(snapshot.profiles[0]).toEqual({...database,hostKey:"local",allowMcpRead:true});
});
