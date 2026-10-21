import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { herdrAgentKey, type HerdrAgent } from "../../app/herdr";
import { allNodes, installHostDom, props, type HostNode } from "../agents/testFixtures/interactionDom";
import { HerdrPane } from "./HerdrPane";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const first: HerdrAgent = { pane_id: "w1:p1", terminal_id: "t1", agent: "codex", name: null,
  title: "First", cwd: null, agent_status: "idle", interactive_ready: true };
const second = { ...first, pane_id: "w1:p2", terminal_id: "t2", title: "Second" };
let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  vi.unstubAllGlobals(); vi.useRealTimers(); invoke.mockReset();
});

async function mount(entries = [first, second]) {
  invoke.mockImplementation(async (command: string, args: { target?: string }) => {
    if (command === "herdr_agents") return entries;
    if (command === "herdr_read") return { agent: entries.find(agent => agent.pane_id === args.target), text: "Herdr output" };
    return null;
  });
  const container = installHostDom();
  root = createRoot(container as unknown as Element);
  await act(async () => root!.render(<I18nProvider locale="zh-TW"><HerdrPane enabled /></I18nProvider>));
  return container;
}

async function select(container: HostNode, agent: HerdrAgent) {
  await act(async () => props(allNodes(container).find(node => node.tagName === "SELECT")!).onChange({ target: { value: herdrAgentKey(agent) } }));
}

function composer(container: HostNode) {
  return allNodes(container).find(node => node.attributes.class === "herdr-pane__composer")!;
}

async function type(container: HostNode, value: string) {
  await act(async () => props(allNodes(composer(container)).find(node => node.tagName === "INPUT")!).onChange({ target: { value } }));
}

it("reads the selected terminal and keeps separate drafts when switching", async () => {
  const container = await mount();
  await select(container, first);
  expect(invoke).toHaveBeenCalledWith("herdr_read", { session: "default", target: "w1:p1", terminalId: "t1" });
  expect(container.textContent).toContain("Herdr output");
  await type(container, "First draft");
  await select(container, second);
  expect(props(allNodes(composer(container)).find(node => node.tagName === "INPUT")!).value).toBe("");
  await select(container, first);
  expect(props(allNodes(composer(container)).find(node => node.tagName === "INPUT")!).value).toBe("First draft");
  expect(invoke.mock.calls.some(([command]) => command === "herdr_prompt")).toBe(false);
});

it("preserves failed drafts and never retries a send automatically", async () => {
  const container = await mount();
  await select(container, first);
  await type(container, "請繼續");
  invoke.mockRejectedValueOnce(new Error("timeout"));
  await act(async () => props(composer(container)).onSubmit({ preventDefault() {} }));
  expect(invoke).toHaveBeenCalledWith("herdr_prompt", { session: "default", target: "w1:p1", terminalId: "t1", text: "請繼續" });
  expect(props(allNodes(composer(container)).find(node => node.tagName === "INPUT")!).value).toBe("請繼續");
  expect(container.textContent).toContain("避免重複送出");
  expect(invoke.mock.calls.filter(([command]) => command === "herdr_prompt")).toHaveLength(1);
});

it("disables sends while the selected agent is working", async () => {
  const working = { ...first, agent_status: "working" };
  const container = await mount([working]);
  await select(container, working);
  await type(container, "繼續");
  expect(props(allNodes(composer(container)).find(node => node.tagName === "BUTTON")!).disabled).toBe(true);
  await act(async () => props(composer(container)).onSubmit({ preventDefault() {} }));
  expect(invoke.mock.calls.some(([command]) => command === "herdr_prompt")).toBe(false);
});

it("prevents duplicate submissions and clears a successful draft", async () => {
  const container = await mount();
  await select(container, first);
  await type(container, "繼續");
  let finish!: () => void;
  invoke.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  await act(async () => {
    const submit = props(composer(container)).onSubmit;
    submit({ preventDefault() {} }); submit({ preventDefault() {} });
  });
  expect(invoke.mock.calls.filter(([command]) => command === "herdr_prompt")).toHaveLength(1);
  await act(async () => finish());
  expect(props(allNodes(composer(container)).find(node => node.tagName === "INPUT")!).value).toBe("");
  expect(container.textContent).toContain("Herdr 已接受訊息");
});

it("stops polling while hidden and preserves the draft on return", async () => {
  vi.useFakeTimers();
  const container = await mount();
  await select(container, first);
  await type(container, "未送出的草稿");
  await act(async () => root!.render(<I18nProvider locale="zh-TW"><HerdrPane enabled={false} /></I18nProvider>));
  invoke.mockClear();
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(invoke).not.toHaveBeenCalled();
  await act(async () => root!.render(<I18nProvider locale="zh-TW"><HerdrPane enabled /></I18nProvider>));
  expect(props(allNodes(composer(container)).find(node => node.tagName === "INPUT")!).value).toBe("未送出的草稿");
});

it("requires reselecting a pane after its terminal is replaced", async () => {
  const container = await mount();
  await select(container, first);
  await type(container, "原終端草稿");
  invoke.mockResolvedValueOnce([{ ...first, terminal_id: "replacement" }]);
  await act(async () => props(allNodes(container).find(node => node.tagName === "BUTTON" && node.textContent === "重新整理")!).onClick());
  expect(composer(container)).toBeUndefined();
  expect(invoke.mock.calls.some(([command]) => command === "herdr_prompt")).toBe(false);
});
