import { act, Children, isValidElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installFakeDom } from "../../app/testFixtures/hookDom";
import { createConnectionProfile, emptyDraft } from "../../domain/connection";
import { I18nProvider } from "../../i18n";
import type { ConfirmDialog } from "../overlays/ConfirmDialog";
import { ConnectionDeleteDialog } from "./ConnectionDeleteDialog";

type DialogProps = Parameters<typeof ConfirmDialog>[0];
const captured = vi.hoisted(() => ({ dialog: null as DialogProps | null, invoke: vi.fn() }));
vi.mock("../overlays/ConfirmDialog", () => ({ ConfirmDialog: (props: DialogProps) => { captured.dialog = props; return null; } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: captured.invoke }));
vi.mock("../../app/nativeRuntime", () => ({ hasDesktopBackend: () => true }));

const ssh = createConnectionProfile({ ...emptyDraft(), name: "測試主機", hostname: "lan.invalid", machineId: "machine" }, "ssh");
const rdp = createConnectionProfile({ ...emptyDraft("rdp"), name: "測試桌面", hostname: "wan.invalid", port: 3390, machineId: "machine" }, "rdp");
const otherSsh = { ...ssh, id: "ssh-wan", hostname: "wan.invalid", port: 2222 };
let root: ReturnType<typeof createRoot>;
let onRemove: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>;
let onClose: ReturnType<typeof vi.fn<() => void>>;
let onOpenVault: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  root = createRoot(installFakeDom() as unknown as Element);
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: captured.invoke };
  onRemove = vi.fn(async () => {});
  onClose = vi.fn();
  onOpenVault = vi.fn();
  captured.invoke.mockImplementation(async (command: string) =>
    command === "credential_status" ? { ready: true, provider: "Test vault", detail: null } : false);
});
afterEach(async () => { await act(async () => root.unmount()); vi.clearAllMocks(); });

async function render(profiles = [ssh, rdp]) {
  await act(async () => root.render(
    <I18nProvider locale="zh-TW">
      <ConnectionDeleteDialog profiles={profiles} onRemove={onRemove} onClose={onClose} onOpenVault={onOpenVault} />
    </I18nProvider>,
  ));
  await waitForGuard();
}

async function waitForGuard() {
  for (let attempt = 0; attempt < 20 && captured.dialog!.confirmLabel === "正在檢查…"; attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
  expect(captured.dialog!.confirmLabel).not.toBe("正在檢查…");
}

function findSelect(children: ReactNode): { value: string; disabled: boolean; onChange: (event: { target: { value: string } }) => void; children: ReactNode } | undefined {
  for (const child of Children.toArray(children)) {
    if (!isValidElement<{ children?: ReactNode }>(child)) continue;
    if (child.type === "select") return child.props as ReturnType<typeof findSelect>;
    const nested = findSelect(child.props.children);
    if (nested) return nested;
  }
}

async function choose(value: string) {
  await act(async () => findSelect(captured.dialog!.children)!.onChange({ target: { value } }));
  await waitForGuard();
}

async function confirm() {
  await act(async () => captured.dialog!.onConfirm());
}

it("defaults to one route, labels identical protocols by address, and cancels without deleting", async () => {
  await render([ssh, otherSsh]);
  expect(findSelect(captured.dialog!.children)?.value).toBe(ssh.id);
  const options = Children.toArray(findSelect(captured.dialog!.children)!.children).flat();
  expect(options.filter(isValidElement<{ children: string }>).map((option) => option.props.children).join(" ")).toContain("wan.invalid:2222");
  expect(captured.dialog!.body).toContain("其他連線方式");
  await act(async () => captured.dialog!.onCancel());
  expect(onClose).toHaveBeenCalledOnce();
  expect(onRemove).not.toHaveBeenCalled();
});

it("deletes only a selected secondary route", async () => {
  await render();
  await choose(rdp.id);
  await confirm();
  expect(onRemove.mock.calls).toEqual([[rdp.id]]);
  expect(onClose).toHaveBeenCalledOnce();
});

it("deletes the representative route without deleting its peers", async () => {
  await render();
  await confirm();
  expect(onRemove.mock.calls).toEqual([[ssh.id]]);
});

it("deletes every captured card member, including a different address", async () => {
  await render([ssh, rdp, otherSsh]);
  await choose("");
  expect(captured.dialog!.confirmLabel).toBe("刪除整張卡片");
  expect(captured.dialog!.body).toContain("3 項");
  await confirm();
  expect(onRemove.mock.calls).toEqual([[ssh.id], [rdp.id], [otherSsh.id]]);
  expect(onClose).toHaveBeenCalledOnce();
});

it("deletes the final route without offering an unnecessary scope selector", async () => {
  await render([rdp]);
  expect(findSelect(captured.dialog!.children)).toBeUndefined();
  await confirm();
  expect(onRemove.mock.calls).toEqual([[rdp.id]]);
});

it("locks repeated confirmation, cancellation and selection while deletion is pending", async () => {
  let finish!: () => void;
  onRemove.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  await render();
  await choose("");
  await confirm();
  expect(captured.dialog!.busy).toBe(true);
  expect(findSelect(captured.dialog!.children)?.disabled).toBe(true);
  await confirm();
  await act(async () => captured.dialog!.onCancel());
  expect(onRemove).toHaveBeenCalledOnce();
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(onRemove).toHaveBeenCalledTimes(2);
  expect(onClose).toHaveBeenCalledOnce();
});

it("reports partial failure, stops before later routes and retries only remaining members", async () => {
  onRemove.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("fixture failure"));
  await render([ssh, rdp, otherSsh]);
  await choose("");
  await confirm();
  expect(captured.dialog!.body).toContain("已刪除 1 項");
  expect(captured.dialog!.body).toContain("fixture failure");
  expect(captured.dialog!.confirmDisabled).toBe(true);
  expect(onRemove.mock.calls).toEqual([[ssh.id], [rdp.id]]);
  expect(onClose).not.toHaveBeenCalled();
  await choose("");
  await confirm();
  expect(onRemove.mock.calls).toEqual([[ssh.id], [rdp.id], [rdp.id], [otherSsh.id]]);
  expect(onClose).toHaveBeenCalledOnce();
});

it("keeps all settings when the first deletion fails", async () => {
  onRemove.mockRejectedValueOnce(new Error("fixture failure"));
  await render();
  await choose("");
  await confirm();
  expect(captured.dialog!.body).toContain("已刪除 0 項");
  expect(onClose).not.toHaveBeenCalled();
  expect(onRemove.mock.calls).toEqual([[ssh.id]]);
});

it("checks credentials on every card member before deleting anything", async () => {
  captured.invoke.mockImplementation(async (command: string, args: { profileId?: string }) =>
    command === "credential_status" ? { ready: true, provider: "Test vault", detail: null } : args.profileId === rdp.id);
  await render();
  expect(captured.dialog!.confirmDisabled).toBe(false);
  await choose("");
  expect(captured.dialog!.confirmLabel).toBe("前往金鑰保管庫");
  await confirm();
  expect(onOpenVault).toHaveBeenCalledOnce();
  expect(onRemove).not.toHaveBeenCalled();
});

it("blocks deletion when credential inspection is unavailable", async () => {
  captured.invoke.mockRejectedValue(new Error("vault unavailable"));
  await render();
  await choose("");
  expect(captured.dialog!.confirmDisabled).toBe(true);
  await confirm();
  expect(onRemove).not.toHaveBeenCalled();
});

it("blocks a newly selected scope immediately and ignores its stale inspection after switching back", async () => {
  let finish!: (value: boolean) => void;
  captured.invoke.mockImplementation(async (command: string, args: { profileId?: string }) => {
    if (command === "credential_status") return { ready: true, provider: "Test vault", detail: null };
    if (args.profileId === rdp.id) return new Promise<boolean>((resolve) => { finish = resolve; });
    return false;
  });
  await render();
  await act(async () => findSelect(captured.dialog!.children)!.onChange({ target: { value: "" } }));
  expect(captured.dialog!.confirmDisabled).toBe(true);
  await confirm();
  expect(onRemove).not.toHaveBeenCalled();
  for (let attempt = 0; attempt < 20 && !finish; attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
  expect(finish).toBeTypeOf("function");
  await choose(ssh.id);
  await act(async () => finish(true));
  expect(captured.dialog!.confirmLabel).toBe("刪除這項連線方式");
  expect(captured.dialog!.confirmDisabled).toBe(false);
});
