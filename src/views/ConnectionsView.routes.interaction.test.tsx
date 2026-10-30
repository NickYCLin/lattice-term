import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Workspace } from "../app/useWorkspace";
import { allNodes, installHostDom, props, type HostNode } from "../components/agents/testFixtures/interactionDom";
import { createConnectionProfile, emptyDraft, type ConnectionProfile } from "../domain/connection";
import { I18nProvider } from "../i18n";
import { ConnectionsView } from "./ConnectionsView";

vi.mock("../components/overlays/modalFocus", () => ({ useModalFocus: () => {} }));
vi.mock("../components/files/FileDropZone", () => ({ FileDropZone: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

const primary = { ...createConnectionProfile({ ...emptyDraft(), name: "主機", hostname: "public.invalid" }, "ssh-public"), machineId: "machine" };
const internal = { ...primary, id: "ssh-internal", name: "辦公室連線", hostname: "private.invalid", port: 2222 };
const workstation = { ...primary, id: "ssh-workstation", name: "工作站入口", hostname: "127.0.0.1", port: 14422, username: "other", machineId: undefined };
let container: HostNode;
let root: ReturnType<typeof createRoot>;
let workspace: Workspace;
const connect = vi.fn();
const merge = vi.fn();

beforeEach(() => {
  container = installHostDom();
  root = createRoot(container as unknown as Element);
  connect.mockReset();
  merge.mockReset().mockResolvedValue(null);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

async function render(profiles: ConnectionProfile[], visibleProfiles = profiles, supportedProtocols = ["ssh", "rdp"]) {
  workspace = {
    profiles, visibleGroups: [{ name: "", profiles: visibleProfiles }], visibleProfiles,
    filterActive: visibleProfiles.length !== profiles.length, sortOrder: "name", selectedId: null,
    setSortOrder: vi.fn(), resetFilter: vi.fn(), setSelectedId: vi.fn(),
    duplicateProfile: vi.fn(), toggleFavorite: vi.fn(), loadSamples: vi.fn(), importProfiles: vi.fn(), linkProfiles: merge,
  } as unknown as Workspace;
  await act(async () => root.render(<I18nProvider locale="zh-TW">
    <ConnectionsView workspace={workspace} onCreate={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()}
      onConnect={connect} supportedProtocols={supportedProtocols} backendAvailable mobile={false} />
  </I18nProvider>));
}

function buttons(label: string) {
  return allNodes(container).filter((node) => node.tagName === "BUTTON" && node.textContent === label);
}
async function click(button: HostNode) {
  expect(button).toBeDefined();
  await act(async () => props(button).onClick());
}
function dialog() {
  return allNodes(container).find((node) => ["dialog", "alertdialog"].includes(props(node)?.role));
}
function mergeConfirm() {
  return allNodes(dialog()!).find((node) => node.tagName === "BUTTON" && node.textContent === "合併卡片")!;
}

it("connects a single route immediately without opening a picker", async () => {
  await render([primary]);
  await click(buttons("連線")[0]);
  expect(connect).toHaveBeenCalledExactlyOnceWith(primary);
  expect(dialog()).toBeUndefined();
});

it("opens one picker for same-protocol addresses, preserves custom names and connects only the chosen profile", async () => {
  await render([primary, internal]);
  expect(buttons("連線")).toHaveLength(1);
  expect(container.textContent).not.toContain(internal.name);
  await click(buttons("連線")[0]);
  expect(connect).not.toHaveBeenCalled();
  expect(dialog()).toBeDefined();
  expect(container.textContent).toContain(internal.name);
  expect(container.textContent).toContain("private.invalid:2222");
  const route = allNodes(container).find((node) => node.tagName === "BUTTON" && node.textContent.includes(internal.name))!;
  await act(async () => { props(route).onClick(); props(route).onClick(); });
  expect(connect).toHaveBeenCalledExactlyOnceWith(internal);
  expect(dialog()).toBeUndefined();
});

it("includes routes hidden by the current search instead of connecting the matching route silently", async () => {
  await render([primary, internal], [internal]);
  await click(buttons("連線")[0]);
  expect(connect).not.toHaveBeenCalled();
  expect(dialog()).toBeDefined();
  expect(container.textContent).toContain("public.invalid:22");
  await click(buttons("取消")[0]);
  expect(dialog()).toBeUndefined();
  expect(connect).not.toHaveBeenCalled();
});

it("keeps unavailable protocols visible and disabled without skipping the route choice", async () => {
  const rdp = { ...internal, protocol: "rdp" as const, port: 3389 };
  await render([primary, rdp], undefined, ["ssh"]);
  await click(buttons("連線")[0]);
  const route = allNodes(container).find((node) => node.tagName === "BUTTON" && node.textContent.includes(internal.name))!;
  expect(props(route).disabled).toBe(true);
  await click(route);
  expect(connect).not.toHaveBeenCalled();
  expect(container.textContent).toContain("目前環境不支援此連線方式");
});

it("offers a different-address card for merging, with no inferred tunnel name", async () => {
  await render([primary, internal, workstation]);
  await click(buttons("合併卡片")[0]);
  const select = allNodes(container).find((node) => node.tagName === "SELECT" && props(node).value === "")!;
  const options = allNodes(select).filter((node) => node.tagName === "OPTION");
  expect(options).toHaveLength(2);
  expect(options[1].textContent).toContain(workstation.name);
  expect(options[1].textContent).toContain("127.0.0.1:14422");
  expect(container.textContent).not.toContain("AI 通道");
  await act(async () => props(select).onChange({ currentTarget: { value: workstation.id } }));
  const confirm = mergeConfirm();
  await click(confirm);
  expect(merge).toHaveBeenCalledExactlyOnceWith([primary.id, workstation.id]);
  expect(dialog()).toBeUndefined();
  expect(connect).not.toHaveBeenCalled();
});

it("shows a whole candidate card once and previews every route before merging", async () => {
  const other = { ...workstation, machineId: "other-machine" };
  const peer = { ...other, id: "other-rdp", protocol: "rdp" as const, port: 3389 };
  await render([primary, internal, other, peer]);
  await click(buttons("合併卡片")[0]);
  const select = allNodes(container).find((node) => node.tagName === "SELECT" && props(node).value === "")!;
  expect(allNodes(select).filter((node) => node.tagName === "OPTION")).toHaveLength(2);
  await act(async () => props(select).onChange({ currentTarget: { value: other.id } }));
  expect(container.textContent).toContain("2 個連線方式");
  expect(container.textContent).toContain("127.0.0.1:3389");
});

it.each(["returned", "thrown"])("keeps failed merges open for retry: %s", async (failure) => {
  if (failure === "returned") merge.mockResolvedValue("synthetic conflict");
  else merge.mockRejectedValue(new Error("synthetic conflict"));
  await render([primary, workstation]);
  await click(buttons("合併卡片")[0]);
  const select = allNodes(container).find((node) => node.tagName === "SELECT" && props(node).value === "")!;
  await act(async () => props(select).onChange({ currentTarget: { value: workstation.id } }));
  await click(mergeConfirm());
  expect(dialog()).toBeDefined();
  expect(container.textContent).toContain("synthetic conflict");
  expect(workspace.profiles).toEqual([primary, workstation]);
  merge.mockResolvedValue(null);
  await click(mergeConfirm());
  expect(dialog()).toBeUndefined();
});

it("does not submit a merge twice while the first save is pending", async () => {
  let finish!: (failure: string | null) => void;
  merge.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await render([primary, workstation]);
  await click(buttons("合併卡片")[0]);
  const select = allNodes(container).find((node) => node.tagName === "SELECT" && props(node).value === "")!;
  await act(async () => props(select).onChange({ currentTarget: { value: workstation.id } }));
  const confirm = mergeConfirm();
  await act(async () => { props(confirm).onClick(); props(confirm).onClick(); });
  expect(merge).toHaveBeenCalledTimes(1);
  expect(props(buttons("取消")[0]).disabled).toBe(true);
  await act(async () => finish(null));
  expect(dialog()).toBeUndefined();
});
