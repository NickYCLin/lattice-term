import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { allNodes, installHostDom, props, type HostNode } from "../agents/testFixtures/interactionDom";
import { createConnectionProfile, emptyDraft } from "../../domain/connection";
import { I18nProvider } from "../../i18n";
import { ConnectionCard } from "./ConnectionCard";

let container: HostNode;
let root: ReturnType<typeof createRoot>;
const actions = {
  onSelect: vi.fn(), onEdit: vi.fn(), onDuplicate: vi.fn(), onDelete: vi.fn(),
  onToggleFavorite: vi.fn(), onAddRoute: vi.fn(), onMerge: vi.fn(), onDatabases: vi.fn(),
};

beforeEach(async () => {
  container = installHostDom();
  root = createRoot(container as unknown as Element);
  vi.clearAllMocks();
  await act(async () => root.render(<I18nProvider locale="zh-TW">
    <ConnectionCard profile={createConnectionProfile({ ...emptyDraft(), name: "主機", hostname: "host.example.com" }, "card")}
      selected={false} {...actions} />
  </I18nProvider>));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

function disclosure() {
  return allNodes(container).find(node => node.tagName === "DETAILS")!;
}

it.each(["onEdit", "onDuplicate", "onDelete", "onAddRoute", "onMerge", "onDatabases"] as const)("closes management and restores focus before %s", async action => {
  const details = disclosure();
  const toggle = allNodes(details).find(node => node.tagName === "SUMMARY")!;
  const focus = vi.spyOn(toggle, "focus");
  const buttons = allNodes(details).filter(node => node.tagName === "BUTTON");
  const index = { onAddRoute: 0, onMerge: 1, onDatabases: 2, onEdit: 3, onDuplicate: 4, onDelete: 5 }[action];
  details.setAttribute("open", "");
  actions[action].mockImplementation(() => {
    expect(details.attributes.open).toBeUndefined();
    expect(focus).toHaveBeenCalledOnce();
  });
  await act(async () => props(buttons[index]).onClick());
  expect(actions[action]).toHaveBeenCalledOnce();
  expect(actions.onSelect).not.toHaveBeenCalled();
});

it("closes with Escape without consuming other keys", () => {
  const details = disclosure();
  const toggle = allNodes(details).find(node => node.tagName === "SUMMARY")!;
  const focus = vi.spyOn(toggle, "focus");
  const preventDefault = vi.fn();
  details.setAttribute("open", "");
  props(details).onKeyDown({ key: "Tab", preventDefault });
  expect(details.attributes.open).toBe("");
  expect(preventDefault).not.toHaveBeenCalled();
  props(details).onKeyDown({ key: "Escape", preventDefault });
  expect(details.attributes.open).toBeUndefined();
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(focus).toHaveBeenCalledOnce();
});

it("remains open while tabbing inside and closes when focus leaves", () => {
  const details = disclosure();
  const relatedTarget = allNodes(details).find(node => node.tagName === "BUTTON")!;
  details.setAttribute("open", "");
  const contains = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
  props(details).onBlur({ currentTarget: { contains }, relatedTarget });
  expect(details.attributes.open).toBe("");
  expect(contains).toHaveBeenCalledWith(relatedTarget);
  props(details).onBlur({ currentTarget: { contains }, relatedTarget: null });
  expect(details.attributes.open).toBeUndefined();
});
