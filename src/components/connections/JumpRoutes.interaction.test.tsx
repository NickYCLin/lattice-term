import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { allNodes, installHostDom, props } from "../agents/testFixtures/interactionDom";
import { createConnectionProfile, emptyDraft } from "../../domain/connection";
import { I18nProvider } from "../../i18n";
import { installFakeStorage } from "../../app/testFixtures/agentApis";
import { ConnectionCard } from "./ConnectionCard";
import { JumpMigrationDialog } from "./JumpMigrationDialog";
import { JumpAuthenticationDialog } from "./JumpAuthenticationDialog";
import { DatabaseConnectionCard } from "./DatabaseConnectionCard";
import { emptyDatabase } from "../../domain/database";
vi.mock("../overlays/modalFocus", () => ({ useModalFocus: () => {} }));
vi.mock("../../app/useSavedCredential", () => ({ useSavedCredential: () => ({ state: { mode: "saved" } }) }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const profile = (id: string, hostname: string, name: string) => createConnectionProfile({ ...emptyDraft("ssh"), hostname, username: "fixture", name }, id);

it("selects direct or a named jump route on one card without running either until Connect", async () => {
  const host = installHostDom(); const root = createRoot(host as unknown as Element);
  const direct = vi.fn(); const jump = vi.fn(); const noop = () => {};
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><ConnectionCard profile={profile("target", "target.invalid", "目標")}
      selected={false} onSelect={noop} onEdit={noop} onDuplicate={noop} onDelete={noop} onToggleFavorite={noop} onConnect={direct}
      jumpOptions={[{ key: "direct", label: "直連", connect: direct }, { key: "jump", label: "經跳板：我的入口", connect: jump }]} /></I18nProvider>));
    expect(host.textContent).toContain("支援經跳板");
    const select = allNodes(host).find(node => node.tagName === "SELECT")!;
    await act(async () => props(select).onChange({ target: { value: "jump" } }));
    expect(jump).not.toHaveBeenCalled(); expect(direct).not.toHaveBeenCalled();
    const connect = () => allNodes(host).find(node => node.tagName === "BUTTON" && node.textContent === "連線")!;
    await act(async () => props(connect()).onClick()); expect(jump).toHaveBeenCalledOnce();
    await act(async () => props(select).onChange({ target: { value: "direct" } }));
    await act(async () => props(connect()).onClick()); expect(direct).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); }
});
it("requires a gateway and explicit confirmation before retaining a legacy entry, and supports restore", async () => {
  const host = installHostDom(); const root = createRoot(host as unknown as Element);
  const target = profile("target", "target.invalid", "目標"); const legacy = profile("legacy", "127.0.0.1", "目標（經某通道）"); const gateway = profile("gateway", "gateway.invalid", "自訂跳板名稱");
  const merge = vi.fn(async () => null); const close = vi.fn();
  try {
    const render = (retained = false) => root.render(<I18nProvider locale="zh-TW"><JumpMigrationDialog profiles={[target, { ...legacy, ...(retained ? { retiredTo: target.id } : {}) }, gateway]} onMerge={merge} onClose={close} /></I18nProvider>);
    await act(async () => render()); expect(merge).not.toHaveBeenCalled();
    const confirm = () => allNodes(host).find(node => node.tagName === "BUTTON" && node.textContent.includes("確認整合"))!;
    expect(props(confirm()).disabled).toBe(true);
    await act(async () => props(allNodes(host).find(node => node.tagName === "SELECT")!).onChange({ target: { value: gateway.id } }));
    await act(async () => props(confirm()).onClick()); expect(merge).toHaveBeenCalledWith(legacy.id, target.id, gateway.id);
    await act(async () => render(true));
    await act(async () => props(allNodes(host).find(node => node.tagName === "BUTTON" && node.textContent === "還原到列表")!).onClick());
    expect(merge).toHaveBeenLastCalledWith(legacy.id, undefined, undefined);
    await act(async () => props(allNodes(host).find(node => node.tagName === "BUTTON" && node.textContent === "關閉")!).onClick());
    expect(close).toHaveBeenCalledOnce(); expect(merge).toHaveBeenCalledTimes(2);
  } finally { await act(async () => root.unmount()); }
});
it("passes separate runtime jump authentication and never stores a password in preferences", async () => {
  const cleanup = installFakeStorage(); const host = installHostDom(); const root = createRoot(host as unknown as Element); const next = vi.fn();
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><JumpAuthenticationDialog gateway={profile("gateway", "gateway.invalid", "我的跳板")} onContinue={next} onCancel={() => {}} /></I18nProvider>));
    await act(async () => props(allNodes(host).find(node => node.tagName === "FORM")!).onSubmit({ preventDefault() {} }));
    expect(next).toHaveBeenCalledWith({ profileId: "gateway", auth: { kind: "password", password: "" }, useSavedPassword: true, rememberPassword: false });
    expect(localStorage.getItem("latticeterm.authPrefs.v1")).toBe('{"gateway":{"method":"password","keyPath":""}}');
  } finally { await act(async () => root.unmount()); cleanup(); }
});
it("SQL direct/jump selection changes only the opening request", async () => {
  const host = installHostDom(); const root = createRoot(host as unknown as Element); const open = vi.fn(); const database = { ...emptyDatabase(), route: { kind: "ssh" as const, profileId: "gateway" } };
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><DatabaseConnectionCard profile={database} jumpName="我的跳板" onOpen={open} onEdit={() => {}} /></I18nProvider>));
    await act(async () => props(allNodes(host).find(node => node.tagName === "SELECT")!).onChange({ target: { value: "direct" } }));
    await act(async () => props(allNodes(host).find(node => node.tagName === "BUTTON")!).onClick()); expect(open).toHaveBeenCalledWith(true);
    expect(database.route).toEqual({ kind: "ssh", profileId: "gateway" });
  } finally { await act(async () => root.unmount()); }
});

it("previews a new protocol route and requires a valid target port before merging", async () => {
  const host = installHostDom(); const root = createRoot(host as unknown as Element); const merge = vi.fn(async () => null);
  const target = { ...profile("target", "192.0.2.10", "Synthetic Host"), protocol: "rdp" as const, port: 3389 };
  const legacy = { ...profile("legacy", "127.0.0.1", "Synthetic HostSSH(via Synthetic Gateway)"), port: 14422 };
  const gateway = profile("gateway", "192.0.2.20", "Synthetic Gateway");
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><JumpMigrationDialog profiles={[target, legacy, gateway]} onMerge={merge} onClose={() => {}} /></I18nProvider>));
    expect(host.textContent).toContain("將新增 SSH 路線至 192.0.2.10");
    expect(merge).not.toHaveBeenCalled();
    await act(async () => props(allNodes(host).find(node => node.tagName === "SELECT")!).onChange({ target: { value: gateway.id } }));
    const port = allNodes(host).find(node => props(node)?.type === "number")!;
    const confirm = () => allNodes(host).find(node => node.tagName === "BUTTON" && node.textContent.includes("確認整合"))!;
    await act(async () => props(port).onChange({ target: { value: "0" } })); expect(props(confirm()).disabled).toBe(true);
    await act(async () => props(port).onChange({ target: { value: "2222" } }));
    await act(async () => props(confirm()).onClick()); expect(merge).toHaveBeenCalledWith(legacy.id, target.id, gateway.id, 2222);
  } finally { await act(async () => root.unmount()); }
});
